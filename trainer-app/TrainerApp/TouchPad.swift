import SwiftUI
import UIKit

/// One raw touch point.
struct TouchSample: Codable {
    let tMs: Double      // ms since this tap or swipe began
    let x: Double        // points
    let y: Double        // points
    let nx: Double       // 0–1 across the screen width
    let ny: Double       // 0–1 across the screen height
    let radius: Double?  // finger contact radius
    let force: Double?   // nil when the phone has no pressure sensor

    func shifted(by ms: Double) -> TouchSample {
        TouchSample(tMs: tMs + ms, x: x, y: y, nx: nx, ny: ny, radius: radius, force: force)
    }
}

/// A gesture the touch pad recognised.
struct CapturedGesture {
    enum Kind: String, Codable {
        case swipeUp = "swipe_up"
        case swipeDown = "swipe_down"
        case swipeSide = "swipe_side"
        case tap
        case doubleTap = "double_tap"
        case other

        var label: String {
            switch self {
            case .swipeUp: return "swipe up"
            case .swipeDown: return "swipe down"
            case .swipeSide: return "side swipe"
            case .tap: return "tap"
            case .doubleTap: return "double tap"
            case .other: return "unclear touch"
            }
        }
    }

    let kind: Kind
    let startedAtMs: Double  // ms since the session started
    let durationMs: Double
    let samples: [TouchSample]
}

/// Transparent full-size view that records every touch and reports gestures.
/// It sits on top of the fake feed, so the feed never sees the touches.
struct TouchPad: UIViewRepresentable {
    let sessionStart: Date
    let onGesture: (CapturedGesture) -> Void

    func makeUIView(context: Context) -> CaptureView {
        let view = CaptureView()
        view.backgroundColor = .clear
        view.isMultipleTouchEnabled = true
        return view
    }

    func updateUIView(_ view: CaptureView, context: Context) {
        view.sessionStart = sessionStart
        view.onGesture = onGesture
    }
}

final class CaptureView: UIView {
    var sessionStart = Date()
    var onGesture: ((CapturedGesture) -> Void)?

    private struct PendingTap {
        let time: TimeInterval
        let point: CGPoint
        let samples: [TouchSample]
        let startedAtMs: Double
    }

    private var active: UITouch?
    private var activeStart = CGPoint.zero
    private var activeMaxMove: CGFloat = 0
    private var downTime: TimeInterval = 0
    private var startedAtMs: Double = 0
    private var samples: [TouchSample] = []
    private var lastTap: PendingTap?

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = touches.first else { return }
        // Keep following a finger that is moving. A finger that is resting
        // (for example the hand holding the phone) gives way to a new one.
        if active != nil && activeMaxMove >= 10 { return }
        active = touch
        activeMaxMove = 0
        activeStart = touch.location(in: self)
        downTime = touch.timestamp
        startedAtMs = Date().timeIntervalSince(sessionStart) * 1000
        samples = [sample(touch, at: touch.timestamp)]
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = active, touches.contains(touch) else { return }
        samples.append(sample(touch, at: touch.timestamp))
        let p = touch.location(in: self)
        activeMaxMove = max(activeMaxMove, hypot(p.x - activeStart.x, p.y - activeStart.y))
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = active, touches.contains(touch) else { return }
        finish(touch)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = active, touches.contains(touch) else { return }
        active = nil
        lastTap = nil
    }

    private func finish(_ touch: UITouch) {
        active = nil
        samples.append(sample(touch, at: touch.timestamp))
        let end = touch.location(in: self)
        let durationMs = (touch.timestamp - downTime) * 1000
        let distance = hypot(end.x - activeStart.x, end.y - activeStart.y)
        let travel = max(distance, activeMaxMove)

        if travel >= 60 {
            let dx = end.x - activeStart.x
            let dy = end.y - activeStart.y
            let kind: CapturedGesture.Kind = abs(dy) >= abs(dx) ? (dy < 0 ? .swipeUp : .swipeDown) : .swipeSide
            lastTap = nil
            emit(kind, samples, startedAtMs: startedAtMs, durationMs: durationMs)
        } else if travel < 30 && durationMs <= 350 {
            emit(.tap, samples, startedAtMs: startedAtMs, durationMs: durationMs)
            if let previous = lastTap,
               touch.timestamp - previous.time <= 0.45,
               hypot(end.x - previous.point.x, end.y - previous.point.y) < 50 {
                // Second tap of a double tap: one record holding both taps,
                // with times measured from the first tap.
                let offset = startedAtMs - previous.startedAtMs
                let combined = previous.samples + samples.map { $0.shifted(by: offset) }
                emit(.doubleTap, combined, startedAtMs: previous.startedAtMs, durationMs: offset + durationMs)
                lastTap = nil
            } else {
                lastTap = PendingTap(time: touch.timestamp, point: end, samples: samples, startedAtMs: startedAtMs)
            }
        } else {
            lastTap = nil
            emit(.other, samples, startedAtMs: startedAtMs, durationMs: durationMs)
        }
    }

    private func emit(_ kind: CapturedGesture.Kind, _ points: [TouchSample], startedAtMs: Double, durationMs: Double) {
        onGesture?(CapturedGesture(kind: kind, startedAtMs: startedAtMs, durationMs: durationMs, samples: points))
    }

    private func sample(_ touch: UITouch, at time: TimeInterval) -> TouchSample {
        let p = touch.location(in: self)
        let width = max(bounds.width, 1)
        let height = max(bounds.height, 1)
        return TouchSample(
            tMs: (time - downTime) * 1000,
            x: Double(p.x),
            y: Double(p.y),
            nx: Double(p.x / width),
            ny: Double(p.y / height),
            radius: Double(touch.majorRadius),
            force: touch.maximumPossibleForce > 0 ? Double(touch.force) : nil
        )
    }
}
