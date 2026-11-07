import PhotosUI
import SwiftUI

/// Shared "teach Rizzio from my texts" actions, used by Train and Auto-tune.
enum Learner {
    /// Reads chat screenshots, learns your messages from each, then re-learns your style.
    /// Returns how many screenshots were read and how many of your messages were learned.
    @MainActor
    static func upload(_ items: [PhotosPickerItem], progress: (String) -> Void,
                       onEach: (UIImage?, [String]) -> Void = { _, _ in }) async throws -> (screens: Int, learned: Int) {
        var screens = 0
        var learned = 0
        for (i, item) in items.enumerated() {
            progress("Reading screenshot \(i + 1) of \(items.count)…")
            guard let data = try await item.loadTransferable(type: Data.self),
                  let jpeg = ImageTools.compressedJPEG(from: data) else { continue }
            let messages = try await RizzAPI.learn(fromScreenshot: jpeg)
            screens += 1
            learned += messages.count
            onEach(ImageTools.compressedJPEG(from: data, maxDimension: 160).flatMap(UIImage.init(data:)), messages)
        }
        if learned > 0 {
            progress("Updating your texting style…")
            _ = try await RizzAPI.rebuildProfile()
        }
        return (screens, learned)
    }

    /// Adds pasted messages (one per line) to the ones you already saved, then re-learns your style.
    /// Returns how many new messages were added.
    @MainActor
    static func addMessages(_ text: String, progress: (String) -> Void) async throws -> Int {
        let new = text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard !new.isEmpty else { return 0 }
        progress("Saving your messages…")
        let me = try await RizzAPI.me()
        let existing = me.styleExamples
        let merged = existing + new.filter { !existing.contains($0) }
        try await RizzAPI.updateMe(aboutMe: me.aboutMe, styleExamples: merged)
        progress("Updating your texting style…")
        _ = try await RizzAPI.rebuildProfile()
        return merged.count - existing.count
    }
}

/// A banner pinned to the bottom of the screen, so you always see what's happening
/// no matter where you scrolled when you tapped a button.
struct StatusBanner: View {
    let progress: String?
    let error: String?
    let success: String?

    var body: some View {
        Group {
            if let progress {
                row(Label { Text(progress) } icon: { ProgressView() }, tint: .secondary)
            } else if let error {
                row(Label(error, systemImage: "exclamationmark.triangle.fill"), tint: .red)
            } else if let success {
                row(Label(success, systemImage: "checkmark.circle.fill"), tint: Theme.ink)
            }
        }
        .animation(.easeInOut, value: progress)
        .animation(.easeInOut, value: error)
        .animation(.easeInOut, value: success)
    }

    private func row<V: View>(_ content: V, tint: Color) -> some View {
        content
            .font(.callout.weight(.medium))
            .foregroundStyle(tint)
            .padding(.horizontal, 16).padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.hairline, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .padding(.horizontal, 12).padding(.bottom, 6)
            .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}
