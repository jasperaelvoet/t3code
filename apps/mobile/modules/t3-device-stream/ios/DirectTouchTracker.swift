import Foundation

/// Turns finger events into what the simulator's input accepts: one finger with an optional edge, or
/// exactly two together. Coordinates are 0...1 in the simulator's raw framebuffer.
///
/// The simulator cannot add a finger to a touch in progress, so the first finger waits briefly for a
/// second. Without that, the two fingers of a pinch would begin as a tap on whatever is under them.
final class DirectTouchTracker {
  struct Point: Equatable {
    var x: Double
    var y: Double
  }

  enum Output: Equatable {
    case single(phase: String, point: Point, edge: Int)
    case double(phase: String, first: Point, second: Point)

    var isReliable: Bool {
      switch self {
      case .single(let phase, _, _), .double(let phase, _, _): return phase != "move"
      }
    }
  }

  private enum State {
    case idle
    case holding(id: Int, point: Point, since: Double)
    case single(id: Int, point: Point, edge: Int)
    case double(firstId: Int, first: Point, secondId: Int, second: Point)
  }

  /// Fingers meant to land together reach UIKit within a frame or two of each other.
  static let holdMs: Double = 16
  /// Further than this and the finger is dragging, so there is nothing left to wait for.
  private static let holdSlop = 0.004
  private static let bottomEdgeZone = 0.03
  /// The hub's `edge` value for the bottom of the screen, found by testing: it is what makes swiping up
  /// reach home. Left swipes for back work with no flag, and the other values block them.
  private static let edgeBottom = 3

  private var state = State.idle
  /// Raw framebuffer coordinates only match the screen's bottom edge in portrait.
  var edgesEnabled = true

  private func edge(for point: Point) -> Int {
    edgesEnabled && point.y >= 1 - Self.bottomEdgeZone ? Self.edgeBottom : 0
  }

  func began(id: Int, point: Point, now: Double) -> [Output] {
    switch state {
    case .idle:
      state = .holding(id: id, point: point, since: now)
      return []
    case .holding(let firstId, let first, _):
      state = .double(firstId: firstId, first: first, secondId: id, second: point)
      return [.double(phase: "begin", first: first, second: point)]
    case .single(let firstId, let first, let edge):
      state = .double(firstId: firstId, first: first, secondId: id, second: point)
      return [
        .single(phase: "end", point: first, edge: edge),
        .double(phase: "begin", first: first, second: point),
      ]
    case .double:
      return []  // The simulator has room for two.
    }
  }

  func moved(id: Int, point: Point, now: Double) -> [Output] {
    switch state {
    case .holding(let heldId, let held, _) where heldId == id:
      guard hypot(point.x - held.x, point.y - held.y) > Self.holdSlop else {
        return []
      }
      let edge = edge(for: held)
      state = .single(id: id, point: point, edge: edge)
      return [
        .single(phase: "begin", point: held, edge: edge),
        .single(phase: "move", point: point, edge: edge),
      ]
    case .single(let singleId, _, let edge) where singleId == id:
      state = .single(id: id, point: point, edge: edge)
      return [.single(phase: "move", point: point, edge: edge)]
    case .double(let firstId, let first, let secondId, let second):
      if id == firstId {
        state = .double(firstId: firstId, first: point, secondId: secondId, second: second)
        return [.double(phase: "move", first: point, second: second)]
      }
      if id == secondId {
        state = .double(firstId: firstId, first: first, secondId: secondId, second: point)
        return [.double(phase: "move", first: first, second: point)]
      }
      return []
    default:
      return []
    }
  }

  func ended(id: Int, point: Point, now: Double) -> [Output] {
    switch state {
    case .holding(let heldId, let held, _) where heldId == id:
      state = .idle
      let edge = edge(for: held)
      return [
        .single(phase: "begin", point: held, edge: edge),
        .single(phase: "end", point: point, edge: edge),
      ]
    case .single(let singleId, _, let edge) where singleId == id:
      state = .idle
      return [.single(phase: "end", point: point, edge: edge)]
    case .double(let firstId, let first, let secondId, let second):
      guard id == firstId || id == secondId else { return [] }
      let lifted = Output.double(
        phase: "end", first: id == firstId ? point : first, second: id == secondId ? point : second)
      // The finger still down carries on as a new touch, as if it had just landed.
      let remainingId = id == firstId ? secondId : firstId
      let remaining = id == firstId ? second : first
      state = .single(id: remainingId, point: remaining, edge: 0)
      return [lifted, .single(phase: "begin", point: remaining, edge: 0)]
    default:
      return []
    }
  }

  /// Call on a timer while a finger is held; its touch starts once no second finger came.
  func tick(now: Double) -> [Output] {
    guard case .holding(let id, let point, let since) = state, now - since >= Self.holdMs else {
      return []
    }
    let edge = edge(for: point)
    state = .single(id: id, point: point, edge: edge)
    return [.single(phase: "begin", point: point, edge: edge)]
  }
}
