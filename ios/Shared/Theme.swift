import SwiftUI
import UIKit

/// Rizzio's look: warm paper background, ink text, one terracotta accent, serif headings.
/// Deliberately no gradients, sparkles or emoji, so it reads like a personal tool, not an AI demo.
enum Theme {
    static let accent = Color(light: 0xB8432F, dark: 0xE07A62)       // terracotta
    static let background = Color(light: 0xF5F1EA, dark: 0x151413)   // warm paper
    static let card = Color(light: 0xFFFDF9, dark: 0x201E1C)
    static let ink = Color(light: 0x1E1B18, dark: 0xF2EEE8)
    static let muted = Color(light: 0x7A7068, dark: 0x9C948C)
    static let hairline = Color(light: 0xE4DDD2, dark: 0x34302C)
    static let bubbleMine = Color(light: 0x2B2622, dark: 0xF2EEE8)    // "your" message bubble
    static let bubbleMineText = Color(light: 0xFFFDF9, dark: 0x1E1B18)

    static func serif(_ style: UIFont.TextStyle, weight: UIFont.Weight = .semibold) -> Font {
        let base = UIFont.preferredFont(forTextStyle: style)
        let descriptor = base.fontDescriptor.withDesign(.serif)?
            .addingAttributes([.traits: [UIFontDescriptor.TraitKey.weight: weight]]) ?? base.fontDescriptor
        return Font(UIFont(descriptor: descriptor, size: 0) as CTFont)
    }

    /// Serif navigation titles and the warm background everywhere, set once at launch.
    static func applyAppearance() {
        func serifUIFont(_ size: CGFloat, _ weight: UIFont.Weight) -> UIFont {
            let system = UIFont.systemFont(ofSize: size, weight: weight)
            guard let d = system.fontDescriptor.withDesign(.serif) else { return system }
            return UIFont(descriptor: d, size: size)
        }
        let nav = UINavigationBarAppearance()
        nav.configureWithTransparentBackground()
        nav.backgroundColor = UIColor(Theme.background)
        nav.largeTitleTextAttributes = [.font: serifUIFont(34, .bold), .foregroundColor: UIColor(Theme.ink)]
        nav.titleTextAttributes = [.font: serifUIFont(17, .semibold), .foregroundColor: UIColor(Theme.ink)]
        UINavigationBar.appearance().standardAppearance = nav
        UINavigationBar.appearance().scrollEdgeAppearance = nav
        UINavigationBar.appearance().compactAppearance = nav
    }
}

extension Color {
    init(light: UInt32, dark: UInt32) {
        self.init(UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255,
                           green: CGFloat((hex >> 8) & 0xFF) / 255,
                           blue: CGFloat(hex & 0xFF) / 255,
                           alpha: 1)
        })
    }
}

extension View {
    /// Warm paper background behind a Form/List instead of the stock grey.
    func themedList() -> some View {
        self
            .scrollContentBackground(.hidden)
            .background(Theme.background.ignoresSafeArea())
    }

    /// Rows sit on warm white cards.
    func themedRow() -> some View {
        listRowBackground(Theme.card)
    }
}

/// Small uppercase label used above cards.
struct Eyebrow: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text.uppercased())
            .font(.caption2.weight(.semibold))
            .tracking(1.2)
            .foregroundStyle(Theme.muted)
    }
}
