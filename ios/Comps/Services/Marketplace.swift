import Foundation

/// A card listing on Facebook Marketplace, found by someone running the Comps
/// extension and shared on Comps. Valued here at today's prices.
struct MarketListing: Identifiable, Hashable, Sendable {
    let id: String // Facebook's listing number
    let cardID: String
    let title: String
    let price: Double
    let location: String?
    let grade: String?
    let confident: Bool
    let status: String
    let seenAt: Date
    var card: CardSummary?
    /// What the card is worth; nil when the title could be several cards.
    var value: Double?

    var url: URL { URL(string: "https://www.facebook.com/marketplace/item/\(id)/")! }
    var discount: Double? { value.map { 1 - price / $0 } }
    /// 15%+ and $3+ under value, at a real asking price.
    var isDeal: Bool {
        guard let value, !Marketplace.fakePrice(price, worth: value) else { return false }
        return 1 - price / value >= 0.15 && value - price >= 3
    }
}

enum Marketplace {
    private struct Row: Decodable {
        let id: String
        let cardId: String
        let variant: String?
        let grade: String?
        let title: String
        let price: Double
        let location: String?
        let confident: Bool
        let status: String
        let seenAt: Double
    }

    private static let memes: Set<Int> = [69, 420, 666, 6969, 42069, 80085]

    /// Prices that aren't real offers: free / $0 / $1, 12 / 123 / 1234…, 69 / 420,
    /// 1111 / 9999 / 999999, and absurd asks for a cheap card. Same rule as the website and extension.
    static func fakePrice(_ price: Double, worth: Double?) -> Bool {
        if !(price > 1) || price >= 100_000 { return true }
        if price == price.rounded() {
            let s = String(Int(price))
            if s.count >= 2 && "123456789".hasPrefix(s) { return true }
            if memes.contains(Int(price)) { return true }
            if Set(s).count == 1 && (s.count >= 4 || (worth.map { price > $0 * 3 } ?? false)) { return true }
        }
        if let worth, worth > 0, price >= 500, price > worth * 20 { return true }
        return false
    }

    /// Listings shared in the last two weeks (or just one card's), newest first, fake prices left out.
    @MainActor
    static func listings(cardID: String? = nil) async throws -> [MarketListing] {
        guard let base = Account.shared.baseURL, let key = Account.shared.anonKey else { return [] }
        let since = Int64((Date().timeIntervalSince1970 - 14 * 86_400) * 1000)
        var query = "market_listings?select=id,card_id,variant,grade,title,price,location,confident,status,seen_at&status=neq.sold&seen_at=gt.\(since)"
        if let cardID, let encoded = cardID.addingPercentEncoding(withAllowedCharacters: .alphanumerics) {
            query += "&card_id=eq.\(encoded)&order=price.asc&limit=20"
        } else {
            query += "&order=seen_at.desc&limit=600"
        }
        guard let url = URL(string: "\(base)/rest/v1/\(query)") else { return [] }
        var request = URLRequest(url: url)
        request.setValue(key, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        // Not set up on this site yet (or a hiccup): just nothing to show.
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { return [] }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let rows = try decoder.decode([Row].self, from: data)

        await Catalog.shared.ensureLoaded()
        var out: [MarketListing] = []
        for r in rows where r.id.hasPrefix("fb:") {
            let value = r.confident ? await worth(r) : nil
            if fakePrice(r.price, worth: value) { continue }
            out.append(MarketListing(
                id: String(r.id.dropFirst(3)), cardID: r.cardId, title: r.title, price: r.price, location: r.location,
                grade: r.grade, confident: r.confident, status: r.status, seenAt: Date(millis: r.seenAt),
                card: await Catalog.shared.card(id: r.cardId), value: value))
        }
        return out
    }

    /// Raw price, or the PSA 10 / grade-9 price for slabs (other grades have no price).
    private static func worth(_ r: Row) async -> Double? {
        var grader: String?
        var grade: String?
        if let g = r.grade {
            let parts = g.split(separator: " ")
            guard parts.count == 2, let n = Double(parts[1]) else { return nil }
            guard (parts[0] == "PSA" && n >= 10) || (n >= 9 && n < 10) else { return nil }
            grader = String(parts[0])
            grade = String(parts[1])
        }
        let answers = await Catalog.shared.prices([Catalog.PriceQuery(id: r.cardId, variant: r.variant, grader: grader, grade: grade, condition: "NM")])
        return answers.first??.value
    }
}
