import CoreVideo
import Foundation
import Metal
import QuartzCore

/// Draws decoded frames straight to a Metal layer, always the newest one, and reports when each
/// reaches the screen. A frame that a newer one overtakes before a drawable is free is never drawn:
/// showing it would only make everything after it later.
final class DirectStreamRenderer {
  /// `decodedAt` and `presentedAt` are in `CACurrentMediaTime` seconds.
  var onPresented: ((_ decodedAt: CFTimeInterval, _ presentedAt: CFTimeInterval) -> Void)?

  let layer = CAMetalLayer()
  private let device: MTLDevice
  private let queue: MTLCommandQueue
  private let pipeline: MTLRenderPipelineState
  private var textureCache: CVMetalTextureCache?
  private let renderQueue = DispatchQueue(label: "t3.direct-stream.render", qos: .userInteractive)
  private let lock = NSLock()
  private var newest: (image: CVPixelBuffer, decodedAt: CFTimeInterval)?
  private var rendering = false

  private static let shaders = """
    #include <metal_stdlib>
    using namespace metal;
    struct Out { float4 position [[position]]; float2 uv; };
    vertex Out vertexMain(uint id [[vertex_id]]) {
      float2 uv = float2((id << 1) & 2, id & 2);
      Out out;
      out.position = float4(uv.x * 2 - 1, 1 - uv.y * 2, 0, 1);
      out.uv = uv;
      return out;
    }
    fragment float4 fragmentMain(Out in [[stage_in]], texture2d<float> luma [[texture(0)]],
                                 texture2d<float> chroma [[texture(1)]],
                                 constant float3x3 &matrix [[buffer(0)]]) {
      constexpr sampler s(filter::linear, address::clamp_to_edge);
      float3 ycc = float3(luma.sample(s, in.uv).r, chroma.sample(s, in.uv).rg - 0.5);
      return float4(saturate(matrix * ycc), 1);
    }
    """

  init?() {
    guard
      let device = MTLCreateSystemDefaultDevice(),
      let queue = device.makeCommandQueue(),
      let library = try? device.makeLibrary(source: Self.shaders, options: nil)
    else { return nil }
    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.vertexFunction = library.makeFunction(name: "vertexMain")
    descriptor.fragmentFunction = library.makeFunction(name: "fragmentMain")
    descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
    guard let pipeline = try? device.makeRenderPipelineState(descriptor: descriptor) else {
      return nil
    }
    self.device = device
    self.queue = queue
    self.pipeline = pipeline
    CVMetalTextureCacheCreate(kCFAllocatorDefault, nil, device, nil, &textureCache)
    layer.device = device
    layer.pixelFormat = .bgra8Unorm
    layer.framebufferOnly = true
    layer.isOpaque = true
    layer.contentsGravity = .resize
    // Two is the fewest iOS allows, and every extra one is a frame of queueing.
    layer.maximumDrawableCount = 2
    layer.presentsWithTransaction = false
  }

  /// Safe from any thread.
  func display(_ image: CVPixelBuffer) {
    lock.lock()
    newest = (image, CACurrentMediaTime())
    let start = !rendering
    if start { rendering = true }
    lock.unlock()
    if start { renderQueue.async { [weak self] in self?.renderLoop() } }
  }

  private func renderLoop() {
    while true {
      // Waits here for a free drawable, so the frame is only chosen once one can be drawn.
      let width = currentImageSize()
      if let width, layer.drawableSize != width { layer.drawableSize = width }
      let drawable = layer.nextDrawable()
      lock.lock()
      guard let frame = newest else {
        rendering = false
        lock.unlock()
        return
      }
      newest = nil
      lock.unlock()
      if let drawable { draw(frame.image, decodedAt: frame.decodedAt, to: drawable) }
    }
  }

  private func currentImageSize() -> CGSize? {
    lock.lock()
    defer { lock.unlock() }
    guard let image = newest?.image else { return nil }
    return CGSize(width: CVPixelBufferGetWidth(image), height: CVPixelBufferGetHeight(image))
  }

  private func texture(_ image: CVPixelBuffer, plane: Int, format: MTLPixelFormat) -> (
    CVMetalTexture, MTLTexture
  )? {
    guard let textureCache else { return nil }
    var created: CVMetalTexture?
    CVMetalTextureCacheCreateTextureFromImage(
      kCFAllocatorDefault, textureCache, image, nil, format,
      CVPixelBufferGetWidthOfPlane(image, plane), CVPixelBufferGetHeightOfPlane(image, plane),
      plane, &created)
    guard let created, let metal = CVMetalTextureGetTexture(created) else { return nil }
    return (created, metal)
  }

  /// Full range YCbCr to RGB, for the matrix the encoder tagged the frame with. Columns of a Metal
  /// `float3x3`, each four floats long because a `float3` is stored as sixteen bytes.
  private func colorMatrix(for image: CVPixelBuffer) -> [Float] {
    let key = CVBufferCopyAttachment(image, kCVImageBufferYCbCrMatrixKey, nil) as? String
    if key == (kCVImageBufferYCbCrMatrix_ITU_R_601_4 as String) {
      return [1, 1, 1, 0, 0, -0.34414, 1.772, 0, 1.402, -0.71414, 0, 0]
    }
    return [1, 1, 1, 0, 0, -0.18732, 1.8556, 0, 1.5748, -0.46812, 0, 0]
  }

  private func draw(_ image: CVPixelBuffer, decodedAt: CFTimeInterval, to drawable: CAMetalDrawable) {
    guard
      let luma = texture(image, plane: 0, format: .r8Unorm),
      let chroma = texture(image, plane: 1, format: .rg8Unorm),
      let commands = queue.makeCommandBuffer()
    else { return }
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = drawable.texture
    pass.colorAttachments[0].loadAction = .dontCare
    pass.colorAttachments[0].storeAction = .store
    guard let encoder = commands.makeRenderCommandEncoder(descriptor: pass) else { return }
    encoder.setRenderPipelineState(pipeline)
    encoder.setFragmentTexture(luma.1, index: 0)
    encoder.setFragmentTexture(chroma.1, index: 1)
    var matrix = colorMatrix(for: image)
    encoder.setFragmentBytes(&matrix, length: MemoryLayout<Float>.size * 12, index: 0)
    encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    encoder.endEncoding()
    if let onPresented {
      drawable.addPresentedHandler { presented in
        if presented.presentedTime > 0 { onPresented(decodedAt, presented.presentedTime) }
      }
    }
    // Holds the planes' CoreVideo textures until the GPU has finished reading them.
    commands.addCompletedHandler { _ in
      _ = luma.0
      _ = chroma.0
    }
    commands.present(drawable)
    commands.commit()
  }
}
