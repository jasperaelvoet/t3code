/**
 * The native capture tool's source. It is compiled on the host at first use, because anything running
 * a simulator has Xcode, and kept as a string so it survives bundling the server into one file.
 */
export const SIM_CAPTURE_SOURCE = String.raw`// Captures one simulator's screen and hardware-encodes each frame the moment the simulator draws it.
// Writes u32 length | u8 tag | payload to stdout: 1 parameter sets, 2 keyframe, 3 delta.
// Reads lines from stdin: key forces a keyframe, bitrate <bits per second> changes the rate live.
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurfaceObjC.h>
#import <VideoToolbox/VideoToolbox.h>
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <os/lock.h>

#define CALL(object, name) ((id(*)(id, SEL))objc_msgSend)((object), NSSelectorFromString(name))
#define HAS(object, name) ([(object) respondsToSelector:NSSelectorFromString(name)])

enum { TAG_CONFIG = 1, TAG_KEY = 2, TAG_DELTA = 3 };
static const int MAX_FRAMES_IN_ENCODER = 2;

static VTCompressionSessionRef encoder;
static CMVideoCodecType codec;
static int32_t bitrate;
static int64_t framesCaptured, framesDropped, framesWritten, bytesWritten;
static double encodeSeconds;
static _Atomic int framesInEncoder;
static _Atomic bool forceKey = true;
static IOSurface *surface;
static os_unfair_lock surfaceLock = OS_UNFAIR_LOCK_INIT;
static CMVideoFormatDescriptionRef lastFormat;
static dispatch_queue_t captureQueue;

static void writeAll(const void *bytes, size_t length) {
  const uint8_t *cursor = bytes;
  while (length > 0) {
    ssize_t written = write(STDOUT_FILENO, cursor, length);
    if (written <= 0) exit(0);  // The server went away.
    cursor += written;
    length -= (size_t)written;
  }
}

static void writeMessage(uint8_t tag, const void *payload, size_t length) {
  uint8_t header[5];
  uint32_t total = CFSwapInt32HostToBig((uint32_t)length + 1);
  memcpy(header, &total, 4);
  header[4] = tag;
  writeAll(header, 5);
  writeAll(payload, length);
}

/// u8 NAL length bytes | u8 count | { u16 length | bytes }. The same whichever codec is in use.
static void writeConfig(CMVideoFormatDescriptionRef format) {
  NSMutableData *config = [NSMutableData data];
  size_t count = 0;
  int lengthBytes = 4;
  const uint8_t *set = NULL;
  size_t setLength = 0;
  bool hevc = codec == kCMVideoCodecType_HEVC;
  OSStatus status =
      hevc ? CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(format, 0, &set, &setLength, &count,
                                                                &lengthBytes)
           : CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, 0, &set, &setLength, &count,
                                                                &lengthBytes);
  if (status != noErr) return;
  uint8_t head[2] = {(uint8_t)lengthBytes, (uint8_t)count};
  [config appendBytes:head length:2];
  for (size_t index = 0; index < count; index++) {
    status = hevc ? CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(format, index, &set,
                                                                       &setLength, NULL, NULL)
                  : CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, index, &set,
                                                                       &setLength, NULL, NULL);
    if (status != noErr) return;
    uint16_t length = CFSwapInt16HostToBig((uint16_t)setLength);
    [config appendBytes:&length length:2];
    [config appendBytes:set length:setLength];
  }
  writeMessage(TAG_CONFIG, config.bytes, config.length);
}

static void encoded(void *refcon, void *frameRefcon, OSStatus status, VTEncodeInfoFlags flags,
                    CMSampleBufferRef sample) {
  framesInEncoder--;
  if (sample) {
    encodeSeconds += CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()),
                                                     CMSampleBufferGetPresentationTimeStamp(sample)));
  }
  if (status != noErr || !sample || !CMSampleBufferDataIsReady(sample)) {
    forceKey = true;
    return;
  }
  CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
  bool isKey = true;
  if (attachments && CFArrayGetCount(attachments) > 0) {
    CFDictionaryRef first = CFArrayGetValueAtIndex(attachments, 0);
    isKey = !CFDictionaryContainsKey(first, kCMSampleAttachmentKey_NotSync);
  }
  CMVideoFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sample);
  if (isKey && format && (!lastFormat || !CMFormatDescriptionEqual(format, lastFormat))) {
    if (lastFormat) CFRelease(lastFormat);
    lastFormat = (CMVideoFormatDescriptionRef)CFRetain(format);
  }
  if (isKey && lastFormat) writeConfig(lastFormat);
  CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
  size_t length = 0;
  char *bytes = NULL;
  if (CMBlockBufferGetDataPointer(block, 0, NULL, &length, &bytes) != noErr) return;
  writeMessage(isKey ? TAG_KEY : TAG_DELTA, bytes, length);
  framesWritten++;
  bytesWritten += (int64_t)length;
}

static void applyBitrate(int32_t bits) {
  bitrate = bits;
  VTSessionSetProperty(encoder, kVTCompressionPropertyKey_AverageBitRate,
                       (__bridge CFNumberRef)@(bits));
  // A one second cap of 1.5x stops a burst of motion from overrunning Wi-Fi.
  NSArray *limits = @[ @((int64_t)bits * 3 / 2 / 8), @1 ];
  VTSessionSetProperty(encoder, kVTCompressionPropertyKey_DataRateLimits,
                       (__bridge CFArrayRef)limits);
}

static bool makeEncoder(size_t width, size_t height) {
  if (encoder) {
    VTCompressionSessionCompleteFrames(encoder, kCMTimeInvalid);
    VTCompressionSessionInvalidate(encoder);
    CFRelease(encoder);
    encoder = NULL;
  }
  // EnableLowLatencyRateControl measured four times slower here: 29 ms a frame against 7 ms.
  NSDictionary *hardware = @{
    (__bridge NSString *)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder : @YES,
  };
  OSStatus status = VTCompressionSessionCreate(NULL, (int32_t)width, (int32_t)height, codec,
                                               (__bridge CFDictionaryRef)hardware, NULL, NULL,
                                               encoded, NULL, &encoder);
  if (status != noErr) return false;
  VTSessionSetProperty(encoder, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
  VTSessionSetProperty(encoder, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
  VTSessionSetProperty(encoder, kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality,
                       kCFBooleanTrue);
  VTSessionSetProperty(encoder, kVTCompressionPropertyKey_ProfileLevel,
                       codec == kCMVideoCodecType_HEVC ? kVTProfileLevel_HEVC_Main_AutoLevel
                                                       : kVTProfileLevel_H264_High_AutoLevel);
  // Keyframes are forced on request. Periodic ones would only spike the bitrate.
  VTSessionSetProperty(encoder, kVTCompressionPropertyKey_MaxKeyFrameInterval,
                       (__bridge CFNumberRef) @(INT32_MAX));
  VTSessionSetProperty(encoder, kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
                       (__bridge CFNumberRef) @(0));
  applyBitrate(bitrate);
  VTCompressionSessionPrepareToEncodeFrames(encoder);
  forceKey = true;
  return true;
}

static void captureFrame(void) {
  framesCaptured++;
  os_unfair_lock_lock(&surfaceLock);
  IOSurface *current = surface;
  os_unfair_lock_unlock(&surfaceLock);
  if (!current) return;
  if (framesInEncoder >= MAX_FRAMES_IN_ENCODER) {
    framesDropped++;
    return;
  }
  static size_t width, height;
  if (!encoder || width != (size_t)current.width || height != (size_t)current.height) {
    width = (size_t)current.width;
    height = (size_t)current.height;
    if (!makeEncoder(width, height)) return;
  }
  CVPixelBufferRef image = NULL;
  if (CVPixelBufferCreateWithIOSurface(NULL, (__bridge IOSurfaceRef)current, NULL, &image) !=
      kCVReturnSuccess)
    return;
  NSDictionary *options = nil;
  if (forceKey) {
    forceKey = false;
    options = @{(__bridge NSString *)kVTEncodeFrameOptionKey_ForceKeyFrame : @YES};
  }
  framesInEncoder++;
  CMTime now = CMClockGetTime(CMClockGetHostTimeClock());
  OSStatus status = VTCompressionSessionEncodeFrame(encoder, image, now, kCMTimeInvalid,
                                                    (__bridge CFDictionaryRef)options, NULL, NULL);
  CVPixelBufferRelease(image);
  if (status != noErr) {
    framesInEncoder--;
    forceKey = true;
  }
}

static id findScreen(NSString *udid, int *errorCode) {
  dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW);
  char developerDir[1024] = "/Applications/Xcode.app/Contents/Developer";
  FILE *pipe = popen("/usr/bin/xcode-select -p", "r");
  if (pipe) {
    if (fgets(developerDir, sizeof(developerDir), pipe)) {
      developerDir[strcspn(developerDir, "\n")] = 0;
    }
    pclose(pipe);
  }
  NSError *error = nil;
  id context = ((id(*)(id, SEL, id, NSError **))objc_msgSend)(
      NSClassFromString(@"SimServiceContext"),
      NSSelectorFromString(@"sharedServiceContextForDeveloperDir:error:"), @(developerDir), &error);
  id set = ((id(*)(id, SEL, NSError **))objc_msgSend)(
      context, NSSelectorFromString(@"defaultDeviceSetWithError:"), &error);
  id device = nil;
  for (id candidate in CALL(set, @"devices")) {
    if ([[CALL(candidate, @"UDID") UUIDString] isEqualToString:udid]) device = candidate;
  }
  if (!device) {
    *errorCode = 3;
    return nil;
  }
  id best = nil;
  size_t bestArea = 0;
  for (id port in CALL(CALL(device, @"io"), @"ioPorts")) {
    id descriptor = HAS(port, @"descriptor") ? CALL(port, @"descriptor") : nil;
    if (!descriptor || !HAS(descriptor, @"framebufferSurface") ||
        !HAS(descriptor,
             @"registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:"))
      continue;
    IOSurface *candidate = CALL(descriptor, @"framebufferSurface");
    size_t area = candidate ? (size_t)candidate.width * (size_t)candidate.height : 0;
    if (area > bestArea) {
      best = descriptor;
      bestArea = area;
    }
  }
  if (!best) *errorCode = 4;
  return best;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc < 4) {
      fprintf(stderr, "usage: simCapture <udid> <hevc|h264> <bits per second>\n");
      return 2;
    }
    codec = strcmp(argv[2], "h264") == 0 ? kCMVideoCodecType_H264 : kCMVideoCodecType_HEVC;
    bitrate = (int32_t)atoi(argv[3]);
    int errorCode = 0;
    id screen = findScreen(@(argv[1]), &errorCode);
    if (!screen) {
      fprintf(stderr, "no simulator screen (%d)\n", errorCode);
      return errorCode;
    }
    surface = CALL(screen, @"framebufferSurface");
    captureQueue = dispatch_queue_create(
        "t3.sim-capture",
        dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INTERACTIVE, 0));
    id frameCallback = ^{ captureFrame(); };
    id surfacesChanged = ^(id unmasked, id masked) {
      IOSurface *updated = CALL(screen, @"framebufferSurface");
      os_unfair_lock_lock(&surfaceLock);
      surface = updated;
      os_unfair_lock_unlock(&surfaceLock);
      dispatch_async(captureQueue, ^{ captureFrame(); });
    };
    id propertiesChanged = ^(id properties) {};
    ((void (*)(id, SEL, id, id, id, id, id))objc_msgSend)(
        screen,
        NSSelectorFromString(
            @"registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:"),
        [NSUUID UUID], captureQueue, frameCallback, surfacesChanged, propertiesChanged);
    // Something to send straight away, even when the screen is still.
    dispatch_async(captureQueue, ^{ captureFrame(); });
    if (getenv("T3_CAPTURE_STATS")) {
      dispatch_source_t stats =
          dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
      dispatch_source_set_timer(stats, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC,
                                0);
      dispatch_source_set_event_handler(stats, ^{
        fprintf(stderr, "captured=%lld written=%lld dropped=%lld encodeMs=%.1f mbit=%.2f\n",
                framesCaptured, framesWritten, framesDropped,
                framesWritten ? encodeSeconds * 1000 / (double)framesWritten : 0,
                bytesWritten * 8.0 / 1e6 / (framesWritten / 60.0 + 0.001));
      });
      dispatch_resume(stats);
      (void)CFBridgingRetain(stats);
    }
    [NSThread detachNewThreadWithBlock:^{
      char line[128];
      while (fgets(line, sizeof(line), stdin)) {
        if (strncmp(line, "key", 3) == 0) {
          forceKey = true;
          dispatch_async(captureQueue, ^{ captureFrame(); });
        } else if (strncmp(line, "bitrate ", 8) == 0) {
          int32_t bits = (int32_t)atoi(line + 8);
          dispatch_async(captureQueue, ^{
            if (encoder && bits > 0) applyBitrate(bits);
          });
        }
      }
      exit(0);  // stdin closing means the server is done with this capture.
    }];
    dispatch_main();
  }
}
`;
