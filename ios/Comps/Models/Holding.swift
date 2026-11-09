import Foundation
import SwiftData

/// One line in the collection: a card, how it's graded, how many, what was paid.
@Model
final class Holding {
    @Attribute(.unique) var id: UUID
    var cardID: String
    var game: String
    var name: String
    var setName: String?
    var number: String?
    var imageURL: String?
    var variant: String?
    var grader: String?
    var grade: String?
    var condition: String
    var quantity: Int
    var costBasis: Double?
    var acquiredAt: Date?
    var notes: String?
    var createdAt: Date
    var updatedAt: Date
    /// Deleted locally but not yet pushed to the server.
    var isTombstoned: Bool
    // Cached pricing
    var unitValue: Double?
    var rawPrice: Double?
    var change7d: Double?
    var priceBasis: String?
    var priceUpdatedAt: Date?
    /// "zh" for a Chinese card: no market price, shown with a CHINESE banner.
    var language: String? = nil
    /// Your own value for one copy, used instead of the market price.
    var customValue: Double? = nil

    init(
        id: UUID = UUID(),
        cardID: String,
        game: String,
        name: String,
        setName: String? = nil,
        number: String? = nil,
        imageURL: String? = nil,
        variant: String? = nil,
        grader: String? = nil,
        grade: String? = nil,
        condition: String = "NM",
        quantity: Int = 1,
        costBasis: Double? = nil,
        acquiredAt: Date? = .now,
        notes: String? = nil,
        unitValue: Double? = nil
    ) {
        self.id = id
        self.cardID = cardID
        self.game = game
        self.name = name
        self.setName = setName
        self.number = number
        self.imageURL = imageURL
        self.variant = variant
        self.grader = grader
        self.grade = grade
        self.condition = condition
        self.quantity = quantity
        self.costBasis = costBasis
        self.acquiredAt = acquiredAt
        self.notes = notes
        self.createdAt = .now
        self.updatedAt = .now
        self.isTombstoned = false
        self.unitValue = unitValue
        self.rawPrice = nil
        self.change7d = nil
        self.priceBasis = nil
        self.priceUpdatedAt = unitValue == nil ? nil : .now
    }

    var gameKind: Game { Game(id: game) }
    var isGraded: Bool { grader != nil && grade != nil }
    var isChinese: Bool { language == "zh" }

    /// The value of one copy: yours if you set one, none for a Chinese card, else the market price.
    static func value(market: Double?, language: String?, custom: Double?) -> Double? {
        if let custom { return custom }
        return language == "zh" ? nil : market
    }
    var totalValue: Double? { unitValue.map { $0 * Double(quantity) } }
    var totalCost: Double? { costBasis.map { $0 * Double(quantity) } }
    var gain: Double? {
        guard let v = unitValue, let c = costBasis else { return nil }
        return (v - c) * Double(quantity)
    }

    var subtitle: String {
        var parts: [String] = []
        if let setName, !setName.isEmpty { parts.append(setName) }
        if let number, !number.isEmpty { parts.append("#\(number)") }
        return parts.joined(separator: " · ")
    }

    func touch() { updatedAt = .now }
}

/// Daily total for the portfolio chart when no server is connected.
@Model
final class ValueSnapshot {
    @Attribute(.unique) var day: String
    var value: Double
    var cost: Double

    init(day: String, value: Double, cost: Double) {
        self.day = day
        self.value = value
        self.cost = cost
    }

    var date: Date { Fmt.date(fromDay: day) ?? .now }
}
