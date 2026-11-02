import Foundation

/// Free public APIs the app can call on its own, so scanning and raw prices
/// work at a card show with no server: Pokémon TCG API, Scryfall, YGOPRODeck.
/// Card ids match the server's so holdings sync cleanly later.
enum DirectProviders {
    private static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 15
        c.urlCache = URLCache(memoryCapacity: 8 << 20, diskCapacity: 64 << 20)
        c.requestCachePolicy = .useProtocolCachePolicy
        c.httpAdditionalHeaders = ["User-Agent": "Comps-iOS/1.0", "Accept": "application/json"]
        return URLSession(configuration: c)
    }()

    private static func fetch<T: Decodable>(_ url: URL, snake: Bool = false, headers: [String: String] = [:]) async throws -> T {
        var req = URLRequest(url: url)
        headers.forEach { req.setValue($1, forHTTPHeaderField: $0) }
        let (data, response) = try await session.data(for: req)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw APIError.http(code, url.host ?? "") }
        let decoder = JSONDecoder()
        if snake { decoder.keyDecodingStrategy = .convertFromSnakeCase }
        return try decoder.decode(T.self, from: data)
    }

    // MARK: Pokémon TCG API

    private struct PTCGList: Decodable { var data: [PTCGCard] }
    private struct PTCGOne: Decodable { var data: PTCGCard }
    private struct PTCGCard: Decodable {
        var id: String
        var name: String
        var number: String
        var rarity: String?
        var set: PTCGSet
        var images: PTCGImages?
        var tcgplayer: PTCGTcg?
    }
    private struct PTCGSet: Decodable { var id: String; var name: String; var printedTotal: Int?; var releaseDate: String? }
    private struct PTCGImages: Decodable { var small: String?; var large: String? }
    private struct PTCGTcg: Decodable { var prices: [String: PTCGPrice]? }
    private struct PTCGPrice: Decodable { var low: Double?; var mid: Double?; var market: Double? }

    private static let pokemonVariantOrder = ["holofoil", "normal", "1stEditionHolofoil", "unlimitedHolofoil", "reverseHolofoil", "1stEditionNormal"]
    static let variantLabels = ["normal": "Normal", "holofoil": "Holo", "reverseHolofoil": "Reverse Holo", "1stEditionHolofoil": "1st Edition Holo",
                                "1stEditionNormal": "1st Edition", "unlimitedHolofoil": "Unlimited Holo", "nonfoil": "Non-foil", "foil": "Foil", "etched": "Etched", "default": ""]

    private static func pokemonHeaders() -> [String: String] {
        let key = UserDefaults.standard.string(forKey: Pref.pokemonKey) ?? ""
        return key.isEmpty ? [:] : ["X-Api-Key": key]
    }

    private static func mapPokemon(_ c: PTCGCard) -> ScanCandidate {
        let prices = c.tcgplayer?.prices ?? [:]
        let variants = pokemonVariantOrder.compactMap { v -> VariantPrice? in
            guard let p = prices[v] else { return nil }
            return VariantPrice(variant: v, label: variantLabels[v] ?? v, price: p.market ?? p.mid, grades: nil)
        }
        let primary = variants.first
        let year = c.set.releaseDate.flatMap { Int($0.prefix(4)) }
        let card = CardSummary(id: "pkm:\(c.id)", game: "pokemon", name: c.name, setName: c.set.name, setCode: c.set.id, number: c.number,
                               total: c.set.printedTotal.map(String.init), rarity: c.rarity, year: year, image: c.images?.small, imageLarge: c.images?.large,
                               variant: primary?.variant, price: primary?.price)
        return ScanCandidate(card: card, variants: variants, score: 0.6, reason: "Pokémon TCG API")
    }

    static func pokemon(query: String) async throws -> [ScanCandidate] {
        var comps = URLComponents(string: "https://api.pokemontcg.io/v2/cards")!
        comps.queryItems = [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "pageSize", value: "20"),
            URLQueryItem(name: "orderBy", value: "-set.releaseDate"),
            URLQueryItem(name: "select", value: "id,name,number,rarity,set,images,tcgplayer"),
        ]
        let res: PTCGList = try await fetch(comps.url!, headers: pokemonHeaders())
        return res.data.map(mapPokemon)
    }

    /// Pokémon TCG API: wildcard for one word, exact phrase for several.
    static func pokemonNameQuery(_ name: String) -> String {
        let n = name.replacingOccurrences(of: "\"", with: "").replacingOccurrences(of: "*", with: "").trimmingCharacters(in: .whitespaces)
        return n.contains(" ") ? "name:\"\(n)\"" : "name:\(n)*"
    }

    static func pokemonCard(id: String) async throws -> ScanCandidate {
        let res: PTCGOne = try await fetch(URL(string: "https://api.pokemontcg.io/v2/cards/\(id)")!, headers: pokemonHeaders())
        return mapPokemon(res.data)
    }

    // MARK: Scryfall

    private struct SFList: Decodable { var data: [SFCard] }
    private struct SFCard: Decodable {
        var id: String
        var name: String
        var set: String
        var setName: String
        var collectorNumber: String
        var rarity: String?
        var releasedAt: String?
        var imageUris: SFImages?
        var cardFaces: [SFFace]?
        var prices: SFPrices?
    }
    private struct SFFace: Decodable { var imageUris: SFImages? }
    private struct SFImages: Decodable { var small: String?; var normal: String?; var large: String? }
    private struct SFPrices: Decodable { var usd: String?; var usdFoil: String?; var usdEtched: String? }

    private static func mapScryfall(_ c: SFCard) -> ScanCandidate {
        let imgs = c.imageUris ?? c.cardFaces?.first?.imageUris
        var variants: [VariantPrice] = []
        if let p = c.prices?.usd.flatMap(Double.init) { variants.append(VariantPrice(variant: "nonfoil", label: "Non-foil", price: p)) }
        if let p = c.prices?.usdFoil.flatMap(Double.init) { variants.append(VariantPrice(variant: "foil", label: "Foil", price: p)) }
        if let p = c.prices?.usdEtched.flatMap(Double.init) { variants.append(VariantPrice(variant: "etched", label: "Etched", price: p)) }
        let card = CardSummary(id: "mtg:\(c.id)", game: "mtg", name: c.name, setName: c.setName, setCode: c.set, number: c.collectorNumber,
                               rarity: c.rarity?.capitalized, year: c.releasedAt.flatMap { Int($0.prefix(4)) },
                               image: imgs?.normal ?? imgs?.small, imageLarge: imgs?.large ?? imgs?.normal,
                               variant: variants.first?.variant, price: variants.first?.price)
        return ScanCandidate(card: card, variants: variants, score: 0.6, reason: "Scryfall")
    }

    static func scryfall(set: String, number: String) async throws -> ScanCandidate {
        let n = number.drop(while: { $0 == "0" })
        let url = URL(string: "https://api.scryfall.com/cards/\(set.lowercased())/\(n.isEmpty ? number : String(n))")!
        let c: SFCard = try await fetch(url, snake: true)
        var m = mapScryfall(c)
        m.score = 0.95
        m.reason = "Set + collector number"
        return m
    }

    static func scryfall(name: String) async throws -> [ScanCandidate] {
        var comps = URLComponents(string: "https://api.scryfall.com/cards/search")!
        comps.queryItems = [URLQueryItem(name: "q", value: "\(name) game:paper"), URLQueryItem(name: "unique", value: "prints"), URLQueryItem(name: "order", value: "released")]
        let res: SFList = try await fetch(comps.url!, snake: true)
        return res.data.prefix(20).map(mapScryfall)
    }

    static func scryfallCard(id: String) async throws -> ScanCandidate {
        let c: SFCard = try await fetch(URL(string: "https://api.scryfall.com/cards/\(id)")!, snake: true)
        return mapScryfall(c)
    }

    // MARK: YGOPRODeck

    private struct YGOList: Decodable { var data: [YGOCard] }
    private struct YGOCard: Decodable { var id: Int; var name: String; var cardSets: [YGOSet]?; var cardImages: [YGOImage]? }
    private struct YGOSet: Decodable { var setName: String; var setCode: String; var setRarity: String?; var setRarityCode: String?; var setPrice: String? }
    private struct YGOImage: Decodable { var id: Int }
    private struct YGOSetInfo: Decodable { var id: Int }

    static func rarityCode(code: String?, rarity: String?) -> String {
        let c = (code ?? "").replacingOccurrences(of: "(", with: "").replacingOccurrences(of: ")", with: "").trimmingCharacters(in: .whitespaces)
        if !c.isEmpty { return c }
        return (rarity ?? "X").split(separator: " ").compactMap { $0.first }.map { String($0) }.joined().uppercased()
    }

    private static func ygoCandidates(_ c: YGOCard, onlySet: String? = nil) -> [ScanCandidate] {
        let imgID = c.cardImages?.first?.id ?? c.id
        return (c.cardSets ?? [])
            .filter { onlySet == nil || $0.setCode.caseInsensitiveCompare(onlySet!) == .orderedSame }
            .map { s in
                let price = s.setPrice.flatMap(Double.init).flatMap { $0 > 0 ? $0 : nil }
                let card = CardSummary(id: "ygo:\(s.setCode):\(rarityCode(code: s.setRarityCode, rarity: s.setRarity))", game: "yugioh", name: c.name,
                                       setName: s.setName, setCode: s.setCode, number: s.setCode, rarity: s.setRarity,
                                       image: "https://images.ygoprodeck.com/images/cards_small/\(imgID).jpg",
                                       imageLarge: "https://images.ygoprodeck.com/images/cards/\(imgID).jpg", variant: "default", price: price)
                return ScanCandidate(card: card, variants: [VariantPrice(variant: "default", label: s.setRarity ?? "", price: price)],
                                     score: onlySet == nil ? 0.6 : 0.9, reason: onlySet == nil ? "YGOPRODeck" : "Set code")
            }
    }

    static func yugioh(setCode: String) async throws -> [ScanCandidate] {
        var comps = URLComponents(string: "https://db.ygoprodeck.com/api/v7/cardsetsinfo.php")!
        comps.queryItems = [URLQueryItem(name: "setcode", value: setCode)]
        let info: YGOSetInfo = try await fetch(comps.url!, snake: true)
        let res: YGOList = try await fetch(URL(string: "https://db.ygoprodeck.com/api/v7/cardinfo.php?id=\(info.id)")!, snake: true)
        return res.data.flatMap { ygoCandidates($0, onlySet: setCode) }
    }

    static func yugioh(name: String) async throws -> [ScanCandidate] {
        var comps = URLComponents(string: "https://db.ygoprodeck.com/api/v7/cardinfo.php")!
        comps.queryItems = [URLQueryItem(name: "fname", value: name), URLQueryItem(name: "num", value: "5"), URLQueryItem(name: "offset", value: "0")]
        let res: YGOList = try await fetch(comps.url!, snake: true)
        return Array(res.data.flatMap { ygoCandidates($0) }.prefix(30))
    }

    // MARK: Search & pricing

    static func search(_ q: String) async -> [CardSummary] {
        let quoted = q.replacingOccurrences(of: "\"", with: "")
        async let p = try? pokemon(query: pokemonNameQuery(quoted))
        async let m = try? scryfall(name: quoted)
        async let y = try? yugioh(name: quoted)
        let all = (await p ?? []) + (await m ?? []) + (await y ?? [])
        return all.map(\.card).sorted { ($0.price ?? 0) > ($1.price ?? 0) }
    }

    /// Raw market price for a holding's card + variant.
    static func price(cardID: String, variant: String?) async -> (value: Double?, variant: String?) {
        do {
            if cardID.hasPrefix("pkm:") {
                let c = try await pokemonCard(id: String(cardID.dropFirst(4)))
                let v = c.variants.first { $0.variant == variant } ?? c.variants.first
                return (v?.price, v?.variant)
            }
            if cardID.hasPrefix("mtg:") {
                let c = try await scryfallCard(id: String(cardID.dropFirst(4)))
                let v = c.variants.first { $0.variant == variant } ?? c.variants.first
                return (v?.price, v?.variant)
            }
            if cardID.hasPrefix("ygo:") {
                let parts = cardID.split(separator: ":").map(String.init)
                guard parts.count >= 3 else { return (nil, nil) }
                let list = try await yugioh(setCode: parts[1])
                let match = list.first { $0.card.id == cardID } ?? list.first
                return (match?.card.price, "default")
            }
        } catch {}
        return (nil, nil)
    }
}
