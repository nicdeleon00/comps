import Foundation

/// UserDefaults keys shared by views (@AppStorage) and services.
enum Pref {
    static let dataURL = "dataURL"
    static let haptics = "haptics"
    static let scanSound = "scanSound"
    static let scanCondition = "scanCondition"
    static let autoAccept = "autoAccept"
}

enum DataError: LocalizedError {
    case http(Int)
    case notFound

    var errorDescription: String? {
        switch self {
        case .http(let code): "The price site answered with error \(code)."
        case .notFound: "Not found."
        }
    }
}

struct HostedStatus: Decodable {
    struct Counts: Decodable { var cards: Int; var valued: Int; var deals: Int }
    struct Provider: Decodable { var on: Bool }
    var counts: Counts
    var providers: [String: Provider]
}

/// Reads the prices, deals and card pages that the scheduled GitHub job
/// publishes to GitHub Pages. No server of your own needed.
struct HostedData {
    var baseURL: URL

    /// Baked in at build time from the repository (Info.plist CompsDataURL).
    static var defaultURL: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CompsDataURL") as? String ?? ""
        return v.isEmpty || v.hasPrefix("$(") ? "https://nicdeleon00.github.io/comps/" : v
    }

    static var current: HostedData {
        let saved = UserDefaults.standard.string(forKey: Pref.dataURL) ?? ""
        return HostedData(baseURL: normalize(saved) ?? normalize(defaultURL) ?? URL(string: "https://nicdeleon00.github.io/comps/")!)
    }

    static func normalize(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.hasPrefix("http://") && !s.hasPrefix("https://") { s = "https://" + s }
        if !s.hasSuffix("/") { s += "/" }
        guard let url = URL(string: s), url.host != nil else { return nil }
        return url
    }

    static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 30
        c.requestCachePolicy = .useProtocolCachePolicy
        c.urlCache = URLCache(memoryCapacity: 8 << 20, diskCapacity: 150 << 20,
                              directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appendingPathComponent("site-data"))
        return URLSession(configuration: c)
    }()

    func url(_ path: String) -> URL {
        URL(string: path, relativeTo: baseURL)?.absoluteURL ?? baseURL
    }

    func data(_ path: String, fresh: Bool = false) async throws -> Data {
        var req = URLRequest(url: url(path))
        if fresh { req.cachePolicy = .reloadIgnoringLocalCacheData }
        let (data, response) = try await Self.session.data(for: req)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code == 404 { throw DataError.notFound }
        guard (200..<300).contains(code) else { throw DataError.http(code) }
        return data
    }

    func get<T: Decodable>(_ path: String, fresh: Bool = false) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await data(path, fresh: fresh))
    }

    func status() async throws -> HostedStatus { try await get("data/status.json", fresh: true) }

    func deals() async throws -> [Deal] {
        let res: DealsResponse = try await get("data/deals.json")
        return res.items
    }

    func spreads() async throws -> [Spread] {
        let res: SpreadsResponse = try await get("data/spreads.json")
        return res.items
    }

    /// Full card page (history, grades, signals). Cheap cards have none; callers fall back to the catalog.
    func card(_ id: String) async throws -> CardDetail? {
        struct Shard: Decodable { var cards: [String: CardDetail] }
        let digits = id.drop { !$0.isNumber }
        guard let n = Int(digits) else { return nil }
        do {
            let shard: Shard = try await get("data/cards/\(n % 128).json")
            return shard.cards[id]
        } catch DataError.notFound {
            return nil
        }
    }
}
