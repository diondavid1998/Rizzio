import PhotosUI
import SwiftUI

/// The control room: tune how Rizzio sounds, then test-drive it.
struct PersonaView: View {
    @State private var persona = SharedStore.shared.persona
    @State private var saved = SharedStore.shared.persona
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var showAutoTune = false

    private var hasChanges: Bool { persona != saved }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }

                Section {
                    VibeCard(persona: persona)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }

                Section {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(PersonaPreset.all) { preset in
                                Button { apply(preset) } label: {
                                    Text("\(preset.emoji) \(preset.name)")
                                        .font(.subheadline.weight(.semibold))
                                        .padding(.horizontal, 12).padding(.vertical, 8)
                                        .background(Color.pink.opacity(0.12))
                                        .foregroundStyle(.pink)
                                        .clipShape(Capsule())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    Button { showAutoTune = true } label: {
                        Label("Auto-tune from my texts", systemImage: "wand.and.stars")
                    }
                } header: {
                    Text("Start from")
                } footer: {
                    Text("Presets move the sliders; you can fine-tune after. Auto-tune reads the chats you uploaded in Train and sets the sliders to how you really text.")
                }

                ForEach(SliderSpec.Group.allCases, id: \.self) { group in
                    Section(group.rawValue) {
                        ForEach(SliderSpec.all.filter { $0.group == group }) { spec in
                            PersonaSlider(spec: spec, value: binding(for: spec.key))
                        }
                        if group == .strategy {
                            Picker("Goal", selection: $persona.goal) {
                                ForEach(GoalSpec.all) { goal in
                                    Label(goal.title, systemImage: goal.icon).tag(goal.key)
                                }
                            }
                        }
                    }
                }

                Section("Rules") {
                    ForEach(ToggleSpec.all) { spec in
                        Toggle(isOn: toggleBinding(spec.key)) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(spec.title)
                                Text(spec.subtitle).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .tint(.pink)
                    }
                }

                Section {
                    TextField("e.g. politics, my ex, my job", text: $persona.avoid)
                } header: {
                    Text("Never mention")
                }

                Section {
                    TextField("e.g. I'm Nigerian, I can reference jollof. Always make it sound like me, not a poet.", text: $persona.notes, axis: .vertical)
                        .lineLimit(2...5)
                } header: {
                    Text("Anything else Rizzio should know")
                }

                Section {
                    NavigationLink {
                        TestDriveView(persona: persona)
                    } label: {
                        Label("Test drive these settings", systemImage: "steeringwheel")
                    }
                } footer: {
                    Text("See sample replies with your current settings before you save.")
                }

                Section {
                    Button("Reset to defaults", role: .destructive) { persona = .default }
                }
            }
            .navigationTitle("Persona")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }.disabled(!hasChanges)
                    }
                }
            }
            .task { await load() }
            .sheet(isPresented: $showAutoTune) {
                AutoTuneSheet(persona: $persona)
            }
        }
    }

    private func binding(for key: String) -> Binding<Double> {
        Binding(get: { persona.value(key) }, set: { persona.sliders[key] = $0.rounded() })
    }

    private func toggleBinding(_ key: String) -> Binding<Bool> {
        Binding(get: { persona.isOn(key) }, set: { persona.toggles[key] = $0 })
    }

    private func apply(_ preset: PersonaPreset) {
        withAnimation(.spring()) {
            for (key, value) in preset.sliders { persona.sliders[key] = value }
        }
    }

    @MainActor private func load() async {
        do {
            let remote = try await RizzAPI.persona()
            if !hasChanges { persona = remote }
            saved = remote
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor private func save() async {
        isSaving = true
        defer { isSaving = false }
        do {
            try await RizzAPI.savePersona(persona)
            saved = SharedStore.shared.persona
            persona = saved
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - Pieces

/// A slider with its two ends labelled, the way the AI reads it.
struct PersonaSlider: View {
    let spec: SliderSpec
    @Binding var value: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label(spec.title, systemImage: spec.icon)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(Int(value))")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Slider(value: $value, in: 0...100, step: 1)
                .tint(.pink)
            HStack {
                Text(spec.left)
                Spacer()
                Text(spec.right)
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}

/// A one-line read of the current settings, so the sliders feel like a character.
struct VibeCard: View {
    let persona: Persona

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Your vibe").font(.caption.weight(.semibold)).foregroundStyle(.white.opacity(0.8))
            Text(summary).font(.title3.weight(.bold)).foregroundStyle(.white)
            HStack(spacing: 6) {
                ForEach(topTraits, id: \.self) { trait in
                    Text(trait)
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(.white.opacity(0.2))
                        .foregroundStyle(.white)
                        .clipShape(Capsule())
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(
            LinearGradient(colors: [Color(red: 1, green: 0.31, blue: 0.55), Color(red: 1, green: 0.54, blue: 0.3)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    private var summary: String {
        let flirt = persona.value("flirt"), humor = persona.value("humor"), bold = persona.value("boldness")
        let warm = persona.value("warmth"), dry = persona.value("humorStyle")
        switch true {
        case humor > 70 && dry > 70: return "Deadpan menace"
        case humor > 70 && bold > 70: return "Chaotic charmer"
        case flirt > 70 && warm > 70: return "Hopeless romantic"
        case flirt > 70 && bold > 60: return "Smooth operator"
        case warm > 75 && humor > 55: return "Golden retriever"
        case bold < 35 && flirt < 45: return "Low-key and easy"
        case humor > 65: return "The funny one"
        default: return "Balanced and charming"
        }
    }

    private var topTraits: [String] {
        SliderSpec.all
            .map { ($0, persona.value($0.key)) }
            .sorted { abs($0.1 - 50) > abs($1.1 - 50) }
            .prefix(3)
            .map { spec, value in value >= 50 ? spec.right : spec.left }
    }
}

// MARK: - Auto-tune

struct AutoTuneSheet: View {
    @Binding var persona: Persona
    @Environment(\.dismiss) private var dismiss
    @State private var result: AutoTuneResult?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(.red)
                } else if let result {
                    Section {
                        ForEach(result.settings) { setting in
                            if let spec = SliderSpec.byKey[setting.key] {
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Label(spec.title, systemImage: spec.icon).font(.subheadline.weight(.semibold))
                                        Spacer()
                                        Text("\(Int(persona.value(spec.key))) → \(Int(setting.value))")
                                            .font(.subheadline.monospacedDigit())
                                            .foregroundStyle(.pink)
                                    }
                                    Text(setting.reason).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                        if result.lowercase != persona.isOn("lowercase") {
                            Label(result.lowercase ? "Turn on all lowercase" : "Turn off all lowercase", systemImage: "textformat.abc")
                        }
                    } header: {
                        Text("Based on your real messages")
                    }
                    Section {
                        Button("Apply these") {
                            for setting in result.settings { persona.sliders[setting.key] = setting.value }
                            persona.toggles["lowercase"] = result.lowercase
                            dismiss()
                        }
                    } footer: {
                        Text("Then tap Save. You can still move anything by hand.")
                    }
                } else {
                    HStack { ProgressView(); Text("Reading how you text…") }
                }
            }
            .navigationTitle("Auto-tune")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .task {
                do { result = try await RizzAPI.autoTune() } catch { errorMessage = error.localizedDescription }
            }
        }
    }
}

// MARK: - Test drive

struct TestDriveView: View {
    let persona: Persona

    private static let samplePrompts = [
        "Prompt: My most irrational fear\nAnswer: Geese. They know what they did.",
        "Prompt: I'm looking for\nAnswer: Someone who'll split a dessert and then steal half of mine",
        "Prompt: Typical Sunday\nAnswer: Farmers market, long run, then pretending I'll meal prep",
        "Prompt: A shower thought I recently had\nAnswer: Are pigeons just city doves who gave up?",
        "Them: haha ok you win this round. what are you up to this weekend?",
    ]

    @State private var promptIndex = 0
    @State private var customText = ""
    @State private var photoItem: PhotosPickerItem?
    @State private var context: String?
    @State private var replies: [Reply] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section {
                Picker("Sample", selection: $promptIndex) {
                    ForEach(Self.samplePrompts.indices, id: \.self) { i in
                        Text(Self.samplePrompts[i].components(separatedBy: "\n").first ?? "").tag(i)
                    }
                }
                Text(Self.samplePrompts[promptIndex]).font(.callout).foregroundStyle(.secondary)
                Button("Write replies") { Task { await run(text: Self.samplePrompts[promptIndex], jpeg: nil) } }
                    .disabled(isLoading)
            } header: {
                Text("Try a sample")
            }

            Section("Or your own") {
                TextField("Paste a prompt or message", text: $customText, axis: .vertical).lineLimit(1...4)
                Button("Write replies") { Task { await run(text: customText, jpeg: nil) } }
                    .disabled(isLoading || customText.trimmingCharacters(in: .whitespaces).isEmpty)
                PhotosPicker(selection: $photoItem, matching: .screenshots) {
                    Label("Use a screenshot", systemImage: "photo")
                }
            }

            if isLoading {
                Section { HStack { ProgressView(); Text("Writing as you…") } }
            }
            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.red) }
            }
            if !replies.isEmpty {
                Section {
                    ForEach(Array(replies.enumerated()), id: \.offset) { _, reply in
                        ReplyRow(reply: reply)
                    }
                } header: {
                    Text(context ?? "Replies")
                } footer: {
                    Text("Test drives aren't saved and don't teach Rizzio anything. Don't like them? Go back, move a slider, and try again.")
                }
            }
        }
        .navigationTitle("Test drive")
        .onChange(of: photoItem) { item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self), let jpeg = ImageTools.compressedJPEG(from: data) {
                    await run(text: nil, jpeg: jpeg)
                }
                photoItem = nil
            }
        }
    }

    @MainActor private func run(text: String?, jpeg: Data?) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let result = try await RizzAPI.preview(persona: persona, text: text, jpeg: jpeg)
            context = result.context
            replies = result.replies
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
