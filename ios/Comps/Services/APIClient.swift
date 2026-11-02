import Foundation

/// UserDefaults keys shared by views (@AppStorage) and services.
enum Pref {
    static let serverURL = "serverURL"
    static let serverToken = "serverToken"
    static let pokemonKey = "pokemonApiKey"
    static let lastSync = "lastSync"
    static let haptics = "haptics"
    static let scanSound = "scanSound"
    static let scanGame = "scanGame"
    static let scanCondition = "scanCondition"
    static let autoAccept = "autoAccept"
}

enum APIError: LocalizedError {
    case notConfigured
    case http(Int, String)
    case badURL

    var errorDescription: String? {
        switch self {
        case .notConfigured: "No server connected."
        case .http(let code, let msg): code == 401 ? "The server needs an access token." : "Server error \(code): \(msg)"
        case .badURL: "That server address doesn't look right."
        }
    }
}

/// Talks to the Comps server. Construct from settings with `APIClient.current`.
struct APIClient {
    var baseURL: URL
    var token: String?

    static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    static var current: APIClient? {
        let raw = UserDefaults.standard.string(forKey: Pref.serverURL)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !raw.isEmpty, let url = normalize(raw) else { return nil }
        let token = UserDefaults.standard.string(forKey: Pref.serverToken)
        return APIClient(baseURL: url, token: token?.isEmpty == true ? nil : token)
    }

    static func normalize(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.hasPrefix("http://") && !s.hasPrefix("https://") { s = "http://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        guard let url = URL(string: s), url.host != nil else { return nil }
        return url
    }

    func url(for path: String, query: [URLQueryItem] = []) -> URL? {
        guard var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return nil }
        let parts = path.split(separator: "?", maxSplits: 1).map(String.init)
        comps.path = (comps.path.hasSuffix("/") ? String(comps.path.dropLast()) : comps.path) + parts[0]
        var items = query
        if parts.count > 1, let extra = URLComponents(string: "?" + parts[1])?.queryItems { items.append(contentsOf: extra) }
        comps.queryItems = items.isEmpty ? nil : items
        return comps.url
    }

    private func request(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil) async throws -> Data {
        guard let url = url(for: path, query: query) else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await Self.session.data(for: req)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            throw APIError.http(code, String(data: data, encoding: .utf8)?.prefix(160).description ?? "")
        }
        return data
    }

    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        let data = try await request("GET", path, query: query)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, body: B) async throws -> T {
        let data = try await request(method, path, body: try JSONEncoder().encode(body))
        return try JSONDecoder().decode(T.self, from: data)
    }

    // MARK: Endpoints

    func status() async throws -> ServerStatus { try await get("/api/status") }

    func identify(lines: [OCRLine], game: Game?) async throws -> [ScanCandidate] {
        struct Line: Encodable { var text: String; var x: Double; var y: Double; var w: Double; var h: Double; var conf: Double }
        struct Body: Encodable { var lines: [Line]; var game: String }
        let body = Body(
            lines: lines.map { Line(text: $0.text, x: $0.box.minX, y: $0.box.minY, w: $0.box.width, h: $0.box.height, conf: Double($0.confidence)) },
            game: game?.rawValue ?? "auto"
        )
        let res: IdentifyResponse = try await send("POST", "/api/identify", body: body)
        return res.candidates
    }

    func search(_ q: String) async throws -> [CardSummary] {
        let res: SearchResponse = try await get("/api/search", query: [URLQueryItem(name: "q", value: q), URLQueryItem(name: "limit", value: "30")])
        return res.items
    }

    func card(_ id: String) async throws -> CardDetail {
        // URLComponents.path encodes for us; ids only contain letters, digits, ":", "-" and "_".
        try await get("/api/cards/\(id)")
    }

    func deals(kind: String?) async throws -> [Deal] {
        var q = [URLQueryItem(name: "limit", value: "60")]
        if let kind { q.append(URLQueryItem(name: "kind", value: kind)) }
        let res: DealsResponse = try await get("/api/deals", query: q)
        return res.items
    }

    func spreads(sort: String) async throws -> [Spread] {
        let res: SpreadsResponse = try await get("/api/spreads", query: [URLQueryItem(name: "limit", value: "60"), URLQueryItem(name: "sort", value: sort), URLQueryItem(name: "minProfit", value: "0")])
        return res.items
    }

    func prices(_ items: [PriceRequestItem]) async throws -> [PriceItem] {
        let res: PricesResponse = try await send("POST", "/api/prices", body: PriceRequest(items: items))
        return res.items
    }

    func sync(_ items: [ServerHolding], since: Double) async throws -> SyncResponse {
        try await send("POST", "/api/collection/sync", body: SyncRequest(items: items, since: since))
    }

    func collectionHistory(days: Int) async throws -> [(Date, Double)] {
        let res: CollectionSummaryResponse = try await get("/api/collection/summary", query: [URLQueryItem(name: "days", value: String(days))])
        return res.history.compactMap { pair in
            guard pair.count == 2, case .day(let d) = pair[0], case .value(let v) = pair[1], let date = Fmt.date(fromDay: d) else { return nil }
            return (date, v)
        }
    }
}
