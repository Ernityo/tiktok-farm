import Foundation

/// How many times each step asks for its gesture before moving on.
let repeatsPerStep = 10

/// The two gestures the trainer asks for.
enum Expected: String, Codable {
    case swipeUp = "swipe_up"
    case doubleTap = "double_tap"

    var label: String {
        switch self {
        case .swipeUp: return "Swipe up"
        case .doubleTap: return "Double tap"
        }
    }
}

struct Step: Identifiable, Codable {
    let id: Int
    let position: String
    let hands: String
    let gesture: Expected
}

/// Edit this list to change the positions and hand setups.
let steps: [Step] = {
    let raw: [(String, String, Expected)] = [
        ("Standing", "Right thumb, one hand", .swipeUp),
        ("Standing", "Right thumb, one hand", .doubleTap),
        ("Standing", "Left thumb, one hand", .swipeUp),
        ("Standing", "Left thumb, one hand", .doubleTap),
        ("Standing", "Hold in right hand, swipe with left index finger", .swipeUp),
        ("Standing", "Hold in left hand, swipe with right index finger", .swipeUp),
        ("Sitting on a chair", "Right thumb, one hand", .swipeUp),
        ("Sitting on a chair", "Left thumb, one hand", .swipeUp),
        ("Sitting on a chair", "Hold in right hand, swipe with left index finger", .doubleTap),
        ("Sitting on the couch", "Phone on your knee, right thumb", .swipeUp),
        ("Sitting on the couch", "Phone on your knee, left thumb", .swipeUp),
        ("Sitting on the couch", "Hold in right hand, swipe with left index finger", .swipeUp),
        ("Lying on your back in bed", "Phone held above you, right thumb", .swipeUp),
        ("Lying on your back in bed", "Phone held above you, left thumb", .doubleTap),
        ("Lying on your side in bed", "Phone in right hand, right thumb", .swipeUp),
        ("Lying on your side in bed", "Phone in left hand, left thumb", .swipeUp),
        ("Lying on your side in bed", "Phone on pillow, right thumb", .doubleTap),
    ]
    return raw.enumerated().map { index, entry in
        Step(id: index + 1, position: entry.0, hands: entry.1, gesture: entry.2)
    }
}()
