import SwiftUI

struct ContentView: View {
    @StateObject private var trainer = Trainer()

    var body: some View {
        switch trainer.phase {
        case .setup: SetupView(trainer: trainer)
        case .training: TrainingView(trainer: trainer)
        case .done: DoneView(trainer: trainer)
        }
    }
}

struct SetupView: View {
    @ObservedObject var trainer: Trainer

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Phone UDID", text: $trainer.udid)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                } header: {
                    Text("Phone UDID")
                } footer: {
                    Text("Copy it from devices.json on your Mac so the file is tagged with the right phone.")
                }

                Section {
                    Text("\(steps.count) positions, \(repeatsPerStep) gestures each.")
                    Text("Follow the instruction on screen. Swipe up for the next video, double tap to like.")
                }

                Section {
                    Button("Start") { trainer.start() }
                        .disabled(trainer.udid.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .navigationTitle("Swipe Trainer")
        }
    }
}

struct TrainingView: View {
    @ObservedObject var trainer: Trainer

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Step \(trainer.stepIndex + 1) of \(steps.count)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Skip") { trainer.skipStep() }
                    Button("Stop") { trainer.finish() }
                }
                Text(trainer.step.position)
                    .font(.title3.bold())
                Text(trainer.step.hands)
                    .font(.body)
                Text("\(trainer.step.gesture.label): \(trainer.doneInStep) / \(repeatsPerStep)")
                    .font(.headline)
                    .foregroundStyle(.tint)
                Text(trainer.lastNote)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial)

            ZStack {
                ZStack {
                    FeedCard(index: trainer.feedIndex)
                        .id(trainer.feedIndex)
                        .transition(.asymmetric(insertion: .move(edge: .bottom), removal: .move(edge: .top)))
                }
                .animation(.easeInOut(duration: 0.25), value: trainer.feedIndex)

                if trainer.heartVisible {
                    Text("❤️")
                        .font(.system(size: 120))
                        .transition(.scale.combined(with: .opacity))
                }

                TouchPad(sessionStart: trainer.startedAt) { gesture in
                    trainer.handle(gesture)
                }
            }
            .clipped()
            .animation(.easeOut(duration: 0.2), value: trainer.heartVisible)
        }
    }
}

struct FeedCard: View {
    let index: Int

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(hue: Double(index % 12) / 12, saturation: 0.6, brightness: 0.8), .black],
                startPoint: .top,
                endPoint: .bottom
            )
            VStack(spacing: 8) {
                Spacer()
                Text("Video \(index + 1)")
                    .font(.largeTitle.bold())
                    .foregroundStyle(.white)
                Text("Swipe up for next · double tap to like")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.8))
            }
            .padding(.bottom, 80)
        }
    }
}

struct DoneView: View {
    @ObservedObject var trainer: Trainer

    var body: some View {
        VStack(spacing: 20) {
            Text("Session finished")
                .font(.title.bold())
            Text("\(trainer.countedTotal) gestures counted")
                .foregroundStyle(.secondary)
            if let url = trainer.savedFile {
                Text(url.lastPathComponent)
                    .font(.footnote.monospaced())
                    .multilineTextAlignment(.center)
                ShareLink(item: url) {
                    Label("Share file", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.borderedProminent)
            }
            Text("To copy to the Mac: connect the phone, open Finder, select the iPhone, go to Files, open Swipe Trainer and drag the file out.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            Button("New session") { trainer.reset() }
        }
        .padding()
    }
}
