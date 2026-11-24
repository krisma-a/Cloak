// Makes src/camera/fixtures/ocr-sample.png, the small made-up note that src/camera/ocr.test.ts reads.
// FAKE DATA ONLY. Run on a Mac from the project folder:  swift scripts/make-ocr-sample.swift
// If you change the lines, change EXPECTED_LINES in ocr.test.ts too.

import AppKit

let lines = ["Sample note for Cloak", "Jordan Example needs a quiet desk."]
let width = 720
let height = 160
let output = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "src/camera/fixtures/ocr-sample.png"

// 8-bit greyscale, no alpha: black text on white, which keeps the file small.
guard let bitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 1,
  hasAlpha: false, isPlanar: false, colorSpaceName: .deviceWhite, bytesPerRow: 0, bitsPerPixel: 0
), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
  fatalError("Could not make a drawing surface")
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()

let font = NSFont(name: "Helvetica", size: 34) ?? NSFont.systemFont(ofSize: 34)
let style: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.black]
for (index, line) in lines.enumerated() {
  // AppKit counts y from the bottom, so the first line sits highest.
  let y = CGFloat(height) - 64 - CGFloat(index) * 56
  (line as NSString).draw(at: NSPoint(x: 24, y: y), withAttributes: style)
}
NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("Could not encode the PNG") }
try png.write(to: URL(fileURLWithPath: output))
print("Wrote \(output) (\(png.count) bytes)")
