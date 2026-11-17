import Foundation
import Observation

/// Nearby stock: stock.json, written every 15 minutes by the "Nearby stock" job (server/src/stock).
/// Kept apart from the card collection: nothing here touches saved cards.
struct StockDoc: Decodable {
    struct Chain: Decodable {
        var name: String
        var checkedAt: Double?
        var ok: Bool
        var error: String?
        /// True when the chain says how many are on hand.
        var exact: Bool?
    }

    struct Store: Decodable, Identifiable, Hashable {
        var id: String
        var chain: String
        var number: String?
        var name: String
        var address: String?
        var city: String?
        var state: String?
        var zip: String?
        var distance: Double?
        var url: String?
        /// Its counts can't be trusted: "auto" (caught showing a count that never moves) or "manual".
        var suspect: String? = nil
    }

    struct Product: Decodable, Identifiable, Hashable {
        var id: String
        var chain: String
        var name: String
        var price: Double?
        var image: String?
        var url: String?
    }

    /// One product at one store. log: [time, 0 = sold out, otherwise how many (1 when the chain doesn't say)].
    struct Entry: Decodable, Hashable {
        var s: String
        var p: String
        var isIn: Bool
        var low: Bool?
        var qty: Int?
        var since: Double
        var log: [[Double]]?

        enum CodingKeys: String, CodingKey { case s, p, isIn = "in", low, qty, since, log }
    }

    var updatedAt: Double
    var radius: Double
    var chains: [String: Chain]
    var stores: [Store]
    var products: [Product]
    var stock: [Entry]
}

struct StockFilter {
    var chain: String?
    var miles: Double
    var inStockOnly: Bool
    var query: String
}

struct StockStoreGroup: Identifiable {
    struct Line: Identifiable {
        var entry: StockDoc.Entry
        var product: StockDoc.Product
        var id: String { product.id }
    }

    var store: StockDoc.Store
    var chainName: String
    var exact: Bool
    var items: [Line]
    var id: String { store.id }
}

struct StockProductGroup: Identifiable {
    struct Place: Identifiable {
        var entry: StockDoc.Entry
        var store: StockDoc.Store
        var id: String { store.id }
    }

    var product: StockDoc.Product
    var chainName: String
    var exact: Bool
    var places: [Place]
    var id: String { product.id }
}

/// How the Stock screen groups and filters stock.json. The website does the same in web/src/lib/stock.ts.
enum Stock {
    private static func words(_ s: String) -> [String] {
        s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil).lowercased()
            .split { !$0.isLetter && !$0.isNumber }.map(String.init)
    }

    private static func matches(_ name: String, _ query: String) -> Bool {
        let n = words(name).joined(separator: " ")
        return words(query).allSatisfy { n.contains($0) }
    }

    private static func inRange(_ s: StockDoc.Store, _ f: StockFilter) -> Bool {
        (f.chain == nil || s.chain == f.chain) && (s.distance == nil || s.distance! <= f.miles)
    }

    /// Stores closest first. In each: what's in stock (by name), then what sold out lately (newest first).
    static func byStore(_ doc: StockDoc, _ f: StockFilter) -> [StockStoreGroup] {
        let products = Dictionary(doc.products.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var lines: [String: [StockStoreGroup.Line]] = [:]
        for entry in doc.stock {
            guard let product = products[entry.p] else { continue }
            if f.inStockOnly && !entry.isIn { continue }
            if !f.query.isEmpty && !matches(product.name, f.query) { continue }
            lines[entry.s, default: []].append(.init(entry: entry, product: product))
        }
        var out: [StockStoreGroup] = []
        for store in doc.stores where inRange(store, f) {
            let items = (lines[store.id] ?? []).sorted { a, b in
                if a.entry.isIn != b.entry.isIn { return a.entry.isIn }
                return a.entry.isIn ? a.product.name.localizedCompare(b.product.name) == .orderedAscending : a.entry.since > b.entry.since
            }
            if (f.inStockOnly || !f.query.isEmpty) && items.isEmpty { continue }
            let chain = doc.chains[store.chain]
            out.append(.init(store: store, chainName: chain?.name ?? store.chain, exact: chain?.exact ?? false, items: items))
        }
        return out.sorted { ($0.store.distance ?? 1e9) < ($1.store.distance ?? 1e9) }
    }

    /// Products some store in range has, the ones in the most stores first; each with its stores closest first.
    static func byProduct(_ doc: StockDoc, _ f: StockFilter) -> [StockProductGroup] {
        let stores = Dictionary(doc.stores.filter { inRange($0, f) }.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var places: [String: [StockProductGroup.Place]] = [:]
        for entry in doc.stock where entry.isIn {
            guard let store = stores[entry.s] else { continue }
            places[entry.p, default: []].append(.init(entry: entry, store: store))
        }
        var out: [StockProductGroup] = []
        for product in doc.products {
            guard let list = places[product.id], !list.isEmpty else { continue }
            if !f.query.isEmpty && !matches(product.name, f.query) { continue }
            let chain = doc.chains[product.chain]
            out.append(.init(product: product, chainName: chain?.name ?? product.chain, exact: chain?.exact ?? false,
                             places: list.sorted { ($0.store.distance ?? 1e9) < ($1.store.distance ?? 1e9) }))
        }
        return out.sorted { a, b in
            a.places.count != b.places.count ? a.places.count > b.places.count : a.product.name.localizedCompare(b.product.name) == .orderedAscending
        }
    }

    /// "3 on hand" when the chain says how many; otherwise "In stock", "Low stock" or "Sold out".
    static func label(_ e: StockDoc.Entry) -> String {
        if !e.isIn { return "Sold out" }
        if let q = e.qty { return "\(q) on hand" }
        return e.low == true ? "Low stock" : "In stock"
    }

    /// The same for one line of an entry's history.
    static func logLabel(_ code: Double, exact: Bool) -> String {
        code == 0 ? "Sold out" : exact ? "\(Int(code)) on hand" : "In stock"
    }

    /// Distance choices up to how far the checks reach.
    static func radiusOptions(_ reach: Int) -> [Int] {
        [10, 25, 50, 100].filter { $0 < reach } + [reach]
    }

    static func miles(_ d: Double?) -> String? {
        guard let d else { return nil }
        return d < 10 ? String(format: "%.1f mi", d) : "\(Int(d.rounded())) mi"
    }

    static func when(_ ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
}

/// Loads stock.json and keeps the last answer on screen while a newer one loads.
@MainActor
@Observable
final class StockModel {
    enum Phase { case loading, ready, notSetUp, failed }

    static let shared = StockModel()

    var doc: StockDoc?
    var phase: Phase = .loading
    var busy = false
    private var loadedAt: Date?

    /// GitHub Pages site (owner.github.io/repo/) → that repository's name.
    private static func repository(_ base: URL) -> String? {
        guard let host = base.host, host.hasSuffix(".github.io"), let owner = host.split(separator: ".").first,
              let repo = base.pathComponents.first(where: { $0 != "/" }) else { return nil }
        return "\(owner)/\(repo)"
    }

    /// The stock branch's one file; next to the site's data when the site isn't on GitHub Pages.
    static var url: URL {
        let base = HostedData.current.baseURL
        if let repo = repository(base), let u = URL(string: "https://raw.githubusercontent.com/\(repo)/stock/stock.json") { return u }
        return base.appendingPathComponent("data/stock.json")
    }

    /// Where the steps to switch the checks on are.
    static var setupURL: URL? {
        repository(HostedData.current.baseURL).flatMap { URL(string: "https://github.com/\($0)#nearby-stock") }
    }

    /// Loads again when asked to, or when the last answer is older than five minutes.
    func load(force: Bool = false) async {
        if Screenshots.on {
            doc = Screenshots.flag("-stockOff") ? nil : Screenshots.sampleStock()
            phase = doc == nil ? .notSetUp : .ready
            return
        }
        if busy { return }
        if !force, let loadedAt, Date().timeIntervalSince(loadedAt) < 300 { return }
        busy = true
        defer { busy = false }
        var request = URLRequest(url: Self.url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 20
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if code == 404 {
                doc = nil
                phase = .notSetUp
            } else if (200..<300).contains(code) {
                doc = try JSONDecoder().decode(StockDoc.self, from: data)
                phase = .ready
                loadedAt = Date()
            } else if doc == nil {
                phase = .failed
            }
        } catch {
            if doc == nil { phase = .failed }
        }
    }
}
