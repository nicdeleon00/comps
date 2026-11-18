import Foundation

/// history.json: every change in how many of a product each store has (written by
/// server/src/stock/history.js), and what it says about a store. The website works the same out in
/// web/src/lib/stockHistory.ts.
struct StockHistoryDoc: Decodable {
    var updatedAt: Double
    var start: Double
    /// "store id|product id" -> [[time, how many], ...], one point per change.
    var series: [String: [[Double]]]
    var names: [String: String]?
}

struct StockEvent: Identifiable, Hashable {
    enum Kind { case restock, down, soldout }
    var t: Double
    var product: String
    var from: Int
    var to: Int
    var kind: Kind
    var id: String { "\(t)|\(product)|\(from)|\(to)" }
}

struct ProductHistory: Identifiable {
    var product: String
    var points: [(t: Double, n: Int)]
    var now: Int
    var events: [StockEvent]
    var restocks: [StockEvent]
    var lastRestock: StockEvent?
    var avgShelf: Double?
    /// (start, end or nil while still on the shelf)
    var stints: [(start: Double, end: Double?)]
    var id: String { product }
}

struct StoreHistory {
    var products: [ProductHistory]
    var events: [StockEvent]
    var restocks: [StockEvent]
    var weekdays: [Int]
    var usualDay: Int?
    var usualHours: (Int, Int)?
    var avgAdded: Double?
    var avgShelf: Double?
    var lastRestock: StockEvent?
}

enum StockHistory {
    static func product(_ id: String, _ raw: [[Double]]) -> ProductHistory {
        let pts = raw.filter { $0.count >= 2 }.map { (t: $0[0], n: Int($0[1])) }
        var events: [StockEvent] = []
        var stints: [(start: Double, end: Double?)] = []
        for i in pts.indices.dropFirst() {
            let (t, to) = pts[i]
            let from = pts[i - 1].n
            if to > from {
                events.append(StockEvent(t: t, product: id, from: from, to: to, kind: .restock))
                if from == 0 { stints.append((t, nil)) }
            } else if to < from {
                events.append(StockEvent(t: t, product: id, from: from, to: to, kind: to == 0 ? .soldout : .down))
                if to == 0, let last = stints.indices.last, stints[last].end == nil { stints[last].end = t }
            }
        }
        let restocks = events.filter { $0.kind == .restock }
        let done = stints.compactMap { s in s.end.map { $0 - s.start } }
        return ProductHistory(product: id, points: pts, now: pts.last?.n ?? 0, events: events, restocks: restocks,
                              lastRestock: restocks.last, avgShelf: done.isEmpty ? nil : done.reduce(0, +) / Double(done.count), stints: stints)
    }

    /// One store within the last `days` days (times in this phone's time zone).
    static func store(_ doc: StockHistoryDoc, _ storeId: String, now: Double, days: Int) -> StoreHistory {
        let cutoff = now - Double(days) * 86_400_000
        let products = doc.series.compactMap { key, pts -> ProductHistory? in
            let parts = key.split(separator: "|", maxSplits: 1).map(String.init)
            guard parts.count == 2, parts[0] == storeId else { return nil }
            return product(parts[1], pts)
        }
        .sorted { $0.now != $1.now ? $0.now > $1.now : ($0.lastRestock?.t ?? 0) > ($1.lastRestock?.t ?? 0) }
        let events = products.flatMap(\.events).filter { $0.t >= cutoff }.sorted { $0.t > $1.t }
        let restocks = events.filter { $0.kind == .restock }
        var weekdays = Array(repeating: 0, count: 7)
        var hours = Array(repeating: 0, count: 24)
        // Several products restocked in the same check are one delivery.
        let deliveries = Set(restocks.map(\.t))
        let cal = Calendar.current
        for t in deliveries {
            let d = Date(timeIntervalSince1970: t / 1000)
            weekdays[cal.component(.weekday, from: d) - 1] += 1
            hours[cal.component(.hour, from: d)] += 1
        }
        var usualDay: Int?
        var usualHours: (Int, Int)?
        if deliveries.count >= 2 {
            usualDay = weekdays.firstIndex(of: weekdays.max() ?? 0)
            var best = -1, at = 0
            for h in 0..<24 {
                let n = hours[h] + hours[(h + 1) % 24] + hours[(h + 2) % 24]
                if n > best { best = n; at = h }
            }
            usualHours = (at, (at + 3) % 24)
        }
        let shelf = products.flatMap { p in p.stints.compactMap { s -> Double? in guard let e = s.end, s.start >= cutoff else { return nil }; return e - s.start } }
        return StoreHistory(
            products: products, events: events, restocks: restocks, weekdays: weekdays, usualDay: usualDay, usualHours: usualHours,
            avgAdded: restocks.isEmpty ? nil : Double(restocks.reduce(0) { $0 + $1.to - $1.from }) / Double(restocks.count),
            avgShelf: shelf.isEmpty ? nil : shelf.reduce(0, +) / Double(shelf.count),
            lastRestock: restocks.first)
    }

    /// "2d 4h", "5h 10m", "12m".
    static func duration(_ ms: Double) -> String {
        let m = Int((ms / 60_000).rounded())
        if m < 60 { return "\(max(1, m))m" }
        let h = m / 60
        if h < 24 { return m % 60 == 0 ? "\(h)h" : "\(h)h \(m % 60)m" }
        return h % 24 == 0 ? "\(h / 24)d" : "\(h / 24)d \(h % 24)h"
    }

    static let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    static func hour(_ h: Int) -> String { "\(h % 12 == 0 ? 12 : h % 12) \(h < 12 ? "AM" : "PM")" }

    static var url: URL { StockModel.url.deletingLastPathComponent().appendingPathComponent("history.json") }

    static func load() async -> StockHistoryDoc? {
        if Screenshots.on { return Screenshots.sampleStockHistory() }
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 30
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(StockHistoryDoc.self, from: data)
    }
}
