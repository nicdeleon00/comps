import Foundation

/// Graded prices, keyed the same way as the server.
struct Grades: Codable, Hashable {
    var g7: Double?
    var g8: Double?
    var g9: Double?
    var g95: Double?
    var psa10: Double?
    var bgs10: Double?
    var cgc10: Double?
    var sgc10: Double?

    /// Ladder rows that have a value, in display order.
    var ladder: [(label: String, value: Double)] {
        var rows: [(label: String, value: Double)] = []
        if let g7 { rows.append(("Grade 7", g7)) }
        if let g8 { rows.append(("Grade 8", g8)) }
        if let g9 { rows.append(("PSA 9", g9)) }
        if let g95 { rows.append(("Grade 9.5", g95)) }
        if let psa10 { rows.append(("PSA 10", psa10)) }
        if let bgs10 { rows.append(("BGS 10", bgs10)) }
        if let cgc10 { rows.append(("CGC 10", cgc10)) }
        if let sgc10 { rows.append(("SGC 10", sgc10)) }
        return rows
    }

    func value(grader: String?, grade: String?) -> Double? {
        guard let grader, let grade, let g = Double(grade) else { return nil }
        if g >= 10 {
            switch grader.uppercased() {
            case "BGS": return bgs10 ?? psa10
            case "CGC": return cgc10 ?? psa10
            case "SGC": return sgc10 ?? psa10
            default: return psa10
            }
        }
        if g >= 9.5 { return g95 }
        if g >= 9 { return g9 }
        if g >= 8 { return g8 }
        return g7
    }
}

/// A card as returned by the server (or built from a direct provider).
struct CardSummary: Codable, Hashable, Identifiable {
    var id: String
    var game: String
    var name: String
    var setName: String?
    var setCode: String?
    var number: String?
    var total: String?
    var rarity: String?
    var year: Int?
    var image: String?
    var imageLarge: String?
    var variant: String?
    var price: Double?
    var priceLow: Double?
    var change7d: Double?
    var change30d: Double?
    var grades: Grades?
    var volume: Int?

    enum CodingKeys: String, CodingKey {
        case id, game, name, setName = "set", setCode, number, total, rarity, year, image, imageLarge, variant, price, priceLow, change7d, change30d, grades, volume
    }

    var gameKind: Game { Game(id: game) }

    var subtitle: String {
        var parts: [String] = []
        if let setName, !setName.isEmpty { parts.append(setName) }
        if let number, !number.isEmpty {
            if game == "pokemon", let total, number.first?.isNumber == true { parts.append("\(number)/\(total)") }
            else { parts.append("#\(number)") }
        }
        return parts.joined(separator: " · ")
    }

    /// The external art URL (unwraps the server's /img?u= proxy form).
    var imageURL: URL? { ImageURL.resolve(image) }
    var largeImageURL: URL? { ImageURL.resolve(imageLarge ?? image) }
}

struct VariantPrice: Codable, Hashable {
    var variant: String
    var label: String
    var price: Double?
    var grades: Grades?
}

struct ScanCandidate: Codable, Hashable, Identifiable {
    var card: CardSummary
    var variants: [VariantPrice]
    var score: Double
    var reason: String
    var id: String { card.id }
}

struct DealData: Decodable, Hashable {
    var title: String?
    var url: String?
    var grader: String?
    var grade: String?
    var grading: DealGrading?
}

struct DealGrading: Decodable, Hashable {
    var ev: Double?
    var profit: Double?
    var roi: Double?
}

struct Deal: Decodable, Hashable, Identifiable {
    var id: Int
    var kind: String
    var kindLabel: String
    var score: Double
    var price: Double
    var value: Double
    var discount: Double?
    var variantLabel: String?
    var card: CardSummary
    var data: DealData

    var reason: String {
        switch kind {
        case "listing": return data.title.map { "eBay: \($0)" } ?? "eBay Buy It Now"
        case "ask": return "Lowest TCGplayer ask is \(Fmt.percent(discount, signed: false)) under market"
        case "xmarket": return "Cheaper on Cardmarket, before shipping and import"
        case "momentum": return "EU average climbing; US price hasn't followed"
        case "dip": return "Down \(Fmt.percent(discount, signed: false)) from its 30-day median"
        default: return kindLabel
        }
    }
}

struct DealsResponse: Decodable { var items: [Deal]; var total: Int }

struct Spread: Decodable, Hashable, Identifiable {
    var card: CardSummary
    var variant: String
    var variantLabel: String?
    var raw: Double
    var g9: Double?
    var psa10: Double
    var multiple: Double
    var cost: Double
    var ev: Double
    var profit: Double
    var roi: Double
    var breakEven: Double?
    var volume: Int?
    var id: String { card.id + "|" + variant }
}

struct SpreadsResponse: Decodable { var items: [Spread]; var total: Int }

struct HistoryPoint: Decodable, Hashable {
    var day: String
    var raw: Double?
    var g9: Double?
    var psa10: Double?

    init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        day = try c.decode(String.self)
        raw = try c.decodeIfPresent(Double.self)
        g9 = try c.decodeIfPresent(Double.self)
        psa10 = try c.decodeIfPresent(Double.self)
    }

    var date: Date { Fmt.date(fromDay: day) ?? .now }
}

struct GradingResult: Decodable, Hashable {
    var cost: Double
    var ev: Double
    var profit: Double
    var roi: Double
    var breakEven: Double?
    var multiple: Double
    var if10: Double
}

struct VariantDetail: Decodable, Hashable, Identifiable {
    var variant: String
    var label: String
    var price: Double?
    var priceLow: Double?
    var change7d: Double?
    var change30d: Double?
    var grades: Grades?
    var volume: Int?
    var grading: GradingResult?
    var id: String { variant }
}

struct DetailLinks: Decodable, Hashable {
    var ebay: String?
    var ebaySold: String?
    var ebayGraded: String?
    var tcgplayer: String?
    var pricecharting: String?
}

struct Listing: Decodable, Hashable, Identifiable {
    var itemId: String
    var title: String
    var total: Double
    var grader: String?
    var grade: String?
    var url: String
    var id: String { itemId }
}

struct CardDetail: Decodable {
    var card: CardSummary
    var variants: [VariantDetail]
    var history: [String: [HistoryPoint]]
    var signals: [Deal]
    var listings: [Listing]
    var links: DetailLinks
}

enum ImageURL {
    /// Server card images come back as "/img?u=<original>". The phone loads the original directly.
    static func resolve(_ string: String?) -> URL? {
        guard let string, !string.isEmpty else { return nil }
        if string.hasPrefix("/img"), let comps = URLComponents(string: string), let u = comps.queryItems?.first(where: { $0.name == "u" })?.value {
            return URL(string: u)
        }
        if string.hasPrefix("http") { return URL(string: string) }
        return HostedData.current.url(string)
    }

    static func original(_ string: String?) -> String? {
        resolve(string)?.absoluteString
    }
}
