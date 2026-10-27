// Encodes a folder of numbered PNG frames into a silent H.264 MP4 for the website.
//
//   swift tools/frames-to-mp4.swift <frames folder> <fps> <out.mp4> [bitrate in kbit/s, default 1500]
//
// Frames are read in name order (frame_0001.png, frame_0002.png, ...). Uses macOS's AVFoundation,
// so nothing needs installing.
import AVFoundation
import AppKit

let args = CommandLine.arguments
guard args.count >= 4, let fps = Int32(args[2]) else {
    print("usage: swift frames-to-mp4.swift <frames folder> <fps> <out.mp4> [kbit/s]")
    exit(1)
}
let folder = URL(fileURLWithPath: args[1])
let output = URL(fileURLWithPath: args[3])
let bitrate = (args.count > 4 ? Int(args[4]) : nil) ?? 1500

let frames = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
    .filter { $0.pathExtension.lowercased() == "png" }
    .sorted { $0.lastPathComponent < $1.lastPathComponent }
guard let first = frames.first, let firstImage = NSImage(contentsOf: first)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("no PNG frames in \(folder.path)")
    exit(1)
}
let width = firstImage.width, height = firstImage.height

try? FileManager.default.removeItem(at: output)
let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: bitrate * 1000,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
    ],
])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
    kCVPixelBufferWidthKey as String: width,
    kCVPixelBufferHeightKey as String: height,
])
writer.add(input)
// Lets browsers start playing before the whole file has downloaded.
writer.shouldOptimizeForNetworkUse = true
writer.startWriting()
writer.startSession(atSourceTime: .zero)

for (index, url) in frames.enumerated() {
    guard let image = NSImage(contentsOf: url)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else { continue }
    var buffer: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer)
    guard let pixels = buffer else { continue }
    CVPixelBufferLockBaseAddress(pixels, [])
    let context = CGContext(data: CVPixelBufferGetBaseAddress(pixels), width: width, height: height, bitsPerComponent: 8,
                            bytesPerRow: CVPixelBufferGetBytesPerRow(pixels), space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    CVPixelBufferUnlockBaseAddress(pixels, [])
    while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.005) }
    adaptor.append(pixels, withPresentationTime: CMTime(value: CMTimeValue(index), timescale: fps))
}

input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
if writer.status != .completed {
    print("failed: \(writer.error?.localizedDescription ?? "unknown error")")
    exit(1)
}
print("\(output.path): \(frames.count) frames, \(width)x\(height) at \(fps) fps")
