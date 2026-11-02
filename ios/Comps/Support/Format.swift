import SwiftUI

enum Fmt {
    static func money(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        let digits = abs(value) >= 1000 ? 0 : 2
        return value.formatted(.currency(code: "USD").precision(.fractionLength(digits)))
    }

    static func signedMoney(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return (value >= 0 ? "+" : "−") + money(abs(value))
    }

    static func percent(_ value: Double?, signed: Bool = true, digits: Int = 1) -> String {
        guard let value, value.isFinite else { return "—" }
        let body = abs(value).formatted(.percent.precision(.fractionLength(abs(value) >= 0.1 ? 0 : digits)))
        guard signed else { return body }
        return (value > 0 ? "+" : value < 0 ? "−" : "") + body
    }

    static func multiple(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return value >= 10 ? "\(Int(value.rounded()))×" : String(format: "%.1f×", value)
    }

    static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func day(_ date: Date = .now) -> String { dayFormatter.string(from: date) }
    static func date(fromDay string: String) -> Date? { dayFormatter.date(from: string) }
}

enum Game: String, Codable, CaseIterable, Identifiable {
    case pokemon, mtg, yugioh, sports, other

    var id: String { rawValue }

    var label: String {
        switch self {
        case .pokemon: "Pokémon"
        case .mtg: "Magic"
        case .yugioh: "Yu-Gi-Oh!"
        case .sports: "Sports"
        case .other: "Other"
        }
    }

    var tint: Color {
        switch self {
        case .pokemon: Color(red: 0.16, green: 0.47, blue: 0.84)
        case .mtg: Color(red: 0.92, green: 0.41, blue: 0.20)
        case .yugioh: Color(red: 0.11, green: 0.69, blue: 0.48)
        case .sports: Color(red: 0.93, green: 0.63, blue: 0.0)
        case .other: Color(red: 0.91, green: 0.48, blue: 0.64)
        }
    }

    init(id: String) {
        self = Game(rawValue: id) ?? .other
    }
}

enum Grader: String, CaseIterable, Identifiable {
    case psa = "PSA", bgs = "BGS", cgc = "CGC", sgc = "SGC"
    var id: String { rawValue }

    var tint: Color {
        switch self {
        case .psa: Color(red: 0.78, green: 0.06, blue: 0.18)
        case .bgs: Color(red: 0.6, green: 0.48, blue: 0.16)
        case .cgc: Color(red: 0.12, green: 0.37, blue: 0.75)
        case .sgc: Color.primary
        }
    }
}

enum CardCondition: String, CaseIterable, Identifiable {
    case nm = "NM", lp = "LP", mp = "MP", hp = "HP", dmg = "DMG"
    var id: String { rawValue }
    var factor: Double {
        switch self {
        case .nm: 1
        case .lp: 0.82
        case .mp: 0.62
        case .hp: 0.42
        case .dmg: 0.25
        }
    }
}

let gradeOptions = ["10", "9.5", "9", "8.5", "8", "7", "6", "5"]

extension Color {
    static let up = Color(red: 0.19, green: 0.72, blue: 0.36)
    static let down = Color(red: 0.92, green: 0.27, blue: 0.24)
}

extension Date {
    var millis: Double { timeIntervalSince1970 * 1000 }
    init(millis: Double) { self.init(timeIntervalSince1970: millis / 1000) }
}
