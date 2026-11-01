import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// Hardware H.264 decode of the direct stream's frames, in the order they arrive.
///
/// VideoToolbox hands frames back as each one finishes unless temporal processing is requested, so
/// nothing waits on a reorder window. The stream has no B-frames to reorder anyway.
final class DirectStreamDecoder {
  /// Called on a VideoToolbox thread. `submittedAt` is when the frame went in, in uptime milliseconds.
  var onImage: ((_ image: CVPixelBuffer, _ submittedAt: Double) -> Void)?
  /// The decoder cannot continue from the frames it has; the stream must send a keyframe.
  var onNeedsKeyframe: (() -> Void)?

  private var session: VTDecompressionSession?
  private var format: CMVideoFormatDescription?
  private var lengthBytes = 4
  private var awaitingKey = true
  private var frameIndex: Int64 = 0

  deinit { invalidate() }

  func invalidate() {
    if let session {
      VTDecompressionSessionInvalidate(session)
    }
    session = nil
    format = nil
  }

  /// A key frame is prefixed with a u16 length and its avcC record. Delta frames are bare.
  func decode(frame: Data, isKey: Bool) {
    var payload = frame
    if isKey {
      guard frame.count > 2 else { return }
      let length = Int(frame[frame.startIndex]) << 8 | Int(frame[frame.startIndex + 1])
      guard frame.count > 2 + length else { return }
      let description = frame.subdata(
        in: (frame.startIndex + 2)..<(frame.startIndex + 2 + length))
      payload = frame.subdata(in: (frame.startIndex + 2 + length)..<frame.endIndex)
      guard configure(description: description) else {
        onNeedsKeyframe?()
        return
      }
      awaitingKey = false
    } else if awaitingKey {
      return
    }
    guard let session, let format else { return }
    guard let sample = makeSample(payload: payload, format: format) else { return }
    let submittedAt = Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
    var infoFlags = VTDecodeInfoFlags()
    let status = VTDecompressionSessionDecodeFrame(
      session, sampleBuffer: sample,
      flags: [._EnableAsynchronousDecompression, ._1xRealTimePlayback],
      infoFlagsOut: &infoFlags
    ) { [weak self] status, _, image, _, _ in
      guard let self else { return }
      if status != noErr {
        self.fail()
      } else if let image {
        self.onImage?(image, submittedAt)
      }
    }
    if status != noErr { fail() }
  }

  private func fail() {
    // A session the system took away (backgrounding) cannot be reused.
    awaitingKey = true
    onNeedsKeyframe?()
  }

  private func configure(description: Data) -> Bool {
    guard let parsed = Self.formatDescription(avcC: description) else { return false }
    lengthBytes = parsed.lengthBytes
    if let session, let format,
      VTDecompressionSessionCanAcceptFormatDescription(session, formatDescription: parsed.format),
      CMFormatDescriptionEqual(format, otherFormatDescription: parsed.format)
    {
      return true
    }
    invalidate()
    format = parsed.format
    let attributes: [CFString: Any] = [
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
      kCVPixelBufferIOSurfacePropertiesKey: [:] as [CFString: Any],
    ]
    var created: VTDecompressionSession?
    let status = VTDecompressionSessionCreate(
      allocator: kCFAllocatorDefault, formatDescription: parsed.format,
      // iOS decodes H.264 in hardware by default.
      decoderSpecification: nil,
      imageBufferAttributes: attributes as CFDictionary,
      outputCallback: nil, decompressionSessionOut: &created)
    guard status == noErr, let created else { return false }
    VTSessionSetProperty(created, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    session = created
    return true
  }

  private func makeSample(payload: Data, format: CMVideoFormatDescription) -> CMSampleBuffer? {
    var block: CMBlockBuffer?
    let count = payload.count
    guard
      CMBlockBufferCreateWithMemoryBlock(
        allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: count,
        blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
        dataLength: count, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
        == noErr, let block
    else { return nil }
    let copied = payload.withUnsafeBytes { bytes in
      CMBlockBufferReplaceDataBytes(
        with: bytes.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: count)
    }
    guard copied == noErr else { return nil }
    frameIndex += 1
    var timing = CMSampleTimingInfo(
      duration: .invalid, presentationTimeStamp: CMTime(value: frameIndex, timescale: 600),
      decodeTimeStamp: .invalid)
    var size = count
    var sample: CMSampleBuffer?
    guard
      CMSampleBufferCreateReady(
        allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format,
        sampleCount: 1, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
        sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample) == noErr
    else { return nil }
    return sample
  }

  private static func formatDescription(
    avcC: Data
  ) -> (format: CMVideoFormatDescription, lengthBytes: Int)? {
    let bytes = [UInt8](avcC)
    guard bytes.count > 7 else { return nil }
    let lengthBytes = Int(bytes[4] & 3) + 1
    var offset = 5
    var sets: [[UInt8]] = []
    let spsCount = Int(bytes[offset] & 0x1f)
    offset += 1
    for _ in 0..<spsCount {
      guard offset + 2 <= bytes.count else { return nil }
      let length = Int(bytes[offset]) << 8 | Int(bytes[offset + 1])
      offset += 2
      guard offset + length <= bytes.count else { return nil }
      sets.append(Array(bytes[offset..<(offset + length)]))
      offset += length
    }
    guard offset < bytes.count else { return nil }
    let ppsCount = Int(bytes[offset])
    offset += 1
    for _ in 0..<ppsCount {
      guard offset + 2 <= bytes.count else { return nil }
      let length = Int(bytes[offset]) << 8 | Int(bytes[offset + 1])
      offset += 2
      guard offset + length <= bytes.count else { return nil }
      sets.append(Array(bytes[offset..<(offset + length)]))
      offset += length
    }
    guard !sets.isEmpty else { return nil }
    var format: CMFormatDescription?
    let status = withParameterSetPointers(sets) { pointers, sizes in
      CMVideoFormatDescriptionCreateFromH264ParameterSets(
        allocator: kCFAllocatorDefault, parameterSetCount: sets.count,
        parameterSetPointers: pointers, parameterSetSizes: sizes,
        nalUnitHeaderLength: Int32(lengthBytes), formatDescriptionOut: &format)
    }
    guard status == noErr, let format else { return nil }
    return (format, lengthBytes)
  }

  private static func withParameterSetPointers<Result>(
    _ sets: [[UInt8]],
    _ body: (UnsafePointer<UnsafePointer<UInt8>>, UnsafePointer<Int>) -> Result
  ) -> Result {
    let storage = sets.map { set -> UnsafeMutablePointer<UInt8> in
      let pointer = UnsafeMutablePointer<UInt8>.allocate(capacity: set.count)
      pointer.initialize(from: set, count: set.count)
      return pointer
    }
    defer { storage.forEach { $0.deallocate() } }
    let pointers = storage.map { UnsafePointer($0) }
    let sizes = sets.map(\.count)
    return pointers.withUnsafeBufferPointer { pointerBuffer in
      sizes.withUnsafeBufferPointer { sizeBuffer in
        body(pointerBuffer.baseAddress!, sizeBuffer.baseAddress!)
      }
    }
  }
}
