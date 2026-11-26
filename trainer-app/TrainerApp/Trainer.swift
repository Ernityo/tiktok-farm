import Foundation
import SwiftUI
import UIKit

/// One recorded gesture, as written to the session file.
struct GestureRecord: Codable {
    let stepId: Int
    let position: String
    let hands: String
    let expected: Expected
    let kind: CapturedGesture.Kind
    let counted: Bool
    let startedAtMs: Double
    let durationMs: Double
    let samples: [TouchSample]
}

/// The JSON file written for one training session.
struct SessionFile: Codable {
    let phoneUDID: String
    let startedAt: Date
    let screenWidth: Double
    let screenHeight: Double
    let steps: [Step]
    var gestures: [GestureRecord]
}

@MainActor
final class Trainer: ObservableObject {
    enum Phase { case setup, training, done }

    @Published var phase: Phase = .setup
    /// The UDID baked in at build time (PHONE_UDID), so the field is pre-filled.
    /// iOS doesn't let apps read their own phone's UDID, so the Mac sets it.
    private static let bundledUDID = (Bundle.main.object(forInfoDictionaryKey: "PhoneUDID") as? String) ?? ""

    @Published var udid: String = bundledUDID.isEmpty
        ? (UserDefaults.standard.string(forKey: "phoneUDID") ?? "")
        : bundledUDID
    @Published var stepIndex = 0
    @Published var doneInStep = 0
    @Published var feedIndex = 0
    @Published var lastNote = ""
    @Published var heartVisible = false
    @Published var savedFile: URL?
    private(set) var startedAt = Date()

    private var file: SessionFile?
    private var fileURL: URL?

    var step: Step { steps[min(stepIndex, steps.count - 1)] }
    var countedTotal: Int { file?.gestures.filter { $0.counted }.count ?? 0 }

    func start() {
        let trimmed = udid.trimmingCharacters(in: .whitespacesAndNewlines)
        udid = trimmed
        UserDefaults.standard.set(trimmed, forKey: "phoneUDID")
        startedAt = Date()
        stepIndex = 0
        doneInStep = 0
        feedIndex = 0
        lastNote = ""
        file = SessionFile(
            phoneUDID: trimmed,
            startedAt: startedAt,
            screenWidth: Double(UIScreen.main.bounds.width),
            screenHeight: Double(UIScreen.main.bounds.height),
            steps: steps,
            gestures: []
        )
        fileURL = makeFileURL(udid: trimmed, date: startedAt)
        phase = .training
        UIApplication.shared.isIdleTimerDisabled = true
        save()
    }

    /// Every gesture is recorded, counted or not. Only the gesture the step
    /// asks for moves the step forward.
    func handle(_ gesture: CapturedGesture) {
        guard phase == .training else { return }
        let current = step
        let counted = (gesture.kind == .swipeUp && current.gesture == .swipeUp)
            || (gesture.kind == .doubleTap && current.gesture == .doubleTap)

        file?.gestures.append(GestureRecord(
            stepId: current.id,
            position: current.position,
            hands: current.hands,
            expected: current.gesture,
            kind: gesture.kind,
            counted: counted,
            startedAtMs: gesture.startedAtMs,
            durationMs: gesture.durationMs,
            samples: gesture.samples
        ))

        guard counted else {
            lastNote = "Last: \(gesture.kind.label), not counted"
            save()
            return
        }

        doneInStep += 1
        feedIndex += 1
        lastNote = "Counted"
        if gesture.kind == .doubleTap { showHeart() }
        if doneInStep >= repeatsPerStep { nextStep() }
        save()
    }

    func skipStep() {
        guard phase == .training else { return }
        nextStep()
        save()
    }

    func finish() {
        phase = .done
        UIApplication.shared.isIdleTimerDisabled = false
        save()
    }

    func reset() {
        phase = .setup
    }

    private func nextStep() {
        doneInStep = 0
        lastNote = ""
        if stepIndex + 1 >= steps.count {
            finish()
        } else {
            stepIndex += 1
        }
    }

    private func showHeart() {
        heartVisible = true
        Task {
            try? await Task.sleep(nanoseconds: 450_000_000)
            self.heartVisible = false
        }
    }

    private func save() {
        guard let file, let fileURL else { return }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            try encoder.encode(file).write(to: fileURL, options: .atomic)
            savedFile = fileURL
        } catch {
            lastNote = "Save failed: \(error.localizedDescription)"
        }
    }

    /// Files land in the app's Documents folder, which Finder can see on the Mac.
    private func makeFileURL(udid: String, date: Date) -> URL {
        let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let safeUDID = udid.isEmpty ? "unknown" : String(udid.map { $0.isLetter || $0.isNumber ? $0 : "_" })
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return folder.appendingPathComponent("trainer-\(safeUDID)-\(formatter.string(from: date)).json")
    }
}
