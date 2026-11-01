import Foundation

/// Rebuilds what `reedSolomon.ts` in the server's direct stream encodes. The two must stay identical.
enum ReedSolomon {
  private static let tables: (exp: [UInt8], log: [UInt8]) = {
    var exp = [UInt8](repeating: 0, count: 512)
    var log = [UInt8](repeating: 0, count: 256)
    var value = 1
    for power in 0..<255 {
      exp[power] = UInt8(value)
      log[value] = UInt8(power)
      value <<= 1
      if value & 0x100 != 0 { value ^= 0x11d }
    }
    for power in 255..<512 { exp[power] = exp[power - 255] }
    return (exp, log)
  }()

  @inline(__always)
  private static func multiply(_ left: UInt8, _ right: UInt8) -> UInt8 {
    if left == 0 || right == 0 { return 0 }
    return tables.exp[Int(tables.log[Int(left)]) + Int(tables.log[Int(right)])]
  }

  @inline(__always)
  private static func inverse(_ value: UInt8) -> UInt8 {
    tables.exp[255 - Int(tables.log[Int(value)])]
  }

  private static func parityCoefficient(dataShards: Int, parity: Int, data: Int) -> UInt8 {
    inverse(UInt8((dataShards + parity) ^ data))
  }

  private static func invert(_ input: [[UInt8]]) -> [[UInt8]]? {
    var matrix = input
    let size = matrix.count
    var inverted = (0..<size).map { row -> [UInt8] in
      var identity = [UInt8](repeating: 0, count: size)
      identity[row] = 1
      return identity
    }
    for column in 0..<size {
      guard let pivot = (column..<size).first(where: { matrix[$0][column] != 0 }) else { return nil }
      matrix.swapAt(column, pivot)
      inverted.swapAt(column, pivot)
      let scale = inverse(matrix[column][column])
      for index in 0..<size {
        matrix[column][index] = multiply(matrix[column][index], scale)
        inverted[column][index] = multiply(inverted[column][index], scale)
      }
      for row in 0..<size where row != column && matrix[row][column] != 0 {
        let factor = matrix[row][column]
        for index in 0..<size {
          matrix[row][index] ^= multiply(factor, matrix[column][index])
          inverted[row][index] ^= multiply(factor, inverted[column][index])
        }
      }
    }
    return inverted
  }

  /// Fills the missing data shards. `shards` holds data then parity, nil where not received.
  static func recover(shards: inout [Data?], dataShards: Int, shardBytes: Int) -> Bool {
    let missing = (0..<dataShards).filter { shards[$0] == nil }
    if missing.isEmpty { return true }
    var available: [Int] = []
    for index in shards.indices where shards[index] != nil {
      available.append(index)
      if available.count == dataShards { break }
    }
    guard available.count == dataShards else { return false }
    let matrix = available.map { shardIndex -> [UInt8] in
      var row = [UInt8](repeating: 0, count: dataShards)
      if shardIndex < dataShards {
        row[shardIndex] = 1
      } else {
        for column in 0..<dataShards {
          row[column] = parityCoefficient(
            dataShards: dataShards, parity: shardIndex - dataShards, data: column)
        }
      }
      return row
    }
    guard let decode = invert(matrix) else { return false }
    for shardIndex in missing {
      var rebuilt = [UInt8](repeating: 0, count: shardBytes)
      for (column, source) in available.enumerated() {
        let coefficient = decode[shardIndex][column]
        if coefficient == 0 { continue }
        var row = [UInt8](repeating: 0, count: 256)
        for value in 1..<256 { row[value] = multiply(coefficient, UInt8(value)) }
        shards[source]!.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
          let count = min(bytes.count, shardBytes)
          for index in 0..<count { rebuilt[index] ^= row[Int(bytes[index])] }
        }
      }
      shards[shardIndex] = Data(rebuilt)
    }
    return true
  }
}
