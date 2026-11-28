import SwiftUI
import UIKit

enum ImageTools {
    /// Shrinks a screenshot so uploads are fast. Text stays readable at this size.
    static func compressedJPEG(from data: Data, maxDimension: CGFloat = 1600, quality: CGFloat = 0.7) -> Data? {
        guard let image = UIImage(data: data) else { return nil }
        let size = image.size
        let scale = min(1, maxDimension / max(size.width, size.height))
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        return resized.jpegData(compressionQuality: quality)
    }

    /// A small grayscale thumbnail (32x32) of a screenshot, to tell "the same screen again" from a new one.
    /// The status bar (top rows) is left out, since its clock changes between taps.
    static func fingerprint(_ data: Data) -> [UInt8]? {
        guard let image = UIImage(data: data)?.cgImage else { return nil }
        // Core Graphics owns the pixel memory for the whole draw (data: nil). Passing a Swift array with &pixels
        // only lends a pointer for the init call, so drawing later wrote into freed memory and could crash.
        guard let ctx = CGContext(data: nil, width: 32, height: 32, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return nil }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: 32, height: 32))
        guard let base = ctx.data?.assumingMemoryBound(to: UInt8.self) else { return nil }
        var pixels: [UInt8] = []
        pixels.reserveCapacity(32 * 30)
        for row in 2..<32 { // skip the top 2 rows (status bar)
            for col in 0..<32 { pixels.append(base[row * ctx.bytesPerRow + col]) }
        }
        return pixels
    }

    /// Average difference per pixel (0 = identical screen, a different profile is usually well over 10).
    static func distance(_ a: [UInt8], _ b: [UInt8]) -> Double {
        guard a.count == b.count, !a.isEmpty else { return .infinity }
        return Double(zip(a, b).reduce(0) { $0 + abs(Int($1.0) - Int($1.1)) }) / Double(a.count)
    }
}

// MARK: - Keyboard

extension View {
    /// Every form gets a "Done" button above the keyboard and can be scrolled to dismiss it,
    /// so the keyboard never hides the Save buttons below a text box.
    func keyboardDoneButton() -> some View {
        self
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") {
                        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                    }
                    .accessibilityIdentifier("keyboardDone")
                }
            }
    }
}
