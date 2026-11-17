import SwiftUI
import SwiftData

/// Trading with other collectors: the same as the website's Trade section.
@MainActor
struct TradeView: View {
    enum Tab: String, CaseIterable { case traders = "Traders", list = "My list", offers = "Offers" }

    @State private var account = Account.shared
    @State private var profile: Trader?
    @State private var loaded = false
    @State private var error: String?
    @State private var tab: Tab = Screenshots.value("-trade").flatMap(Tab.init(rawValue:)) ?? .traders
    @State private var offers: [TradeOffer] = []
    @State private var signingIn = false
    @State private var editingProfile = false

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Trade")
                .topBarButtons()
                .toolbar {
                    if let profile {
                        ToolbarItem(placement: .topBarLeading) {
                            Button { editingProfile = true } label: { TraderAvatar(trader: profile, size: 28) }
                                .accessibilityLabel("Your trading profile")
                        }
                    }
                }
                .navigationDestination(for: Trader.self) { TraderView(trader: $0, me: profile) }
        }
        .task(id: account.userID) { await load() }
        .onReceive(NotificationCenter.default.publisher(for: .tradeChanged)) { _ in Task { await load() } }
        .sheet(isPresented: $signingIn) { NavigationStack { SignInView() } }
        .sheet(isPresented: $editingProfile) { if let profile { NavigationStack { ProfileForm(existing: profile) } } }
    }

    private var waiting: Int { offers.filter { $0.status == .open && $0.toUser == profile?.userId }.count }

    @ViewBuilder private var content: some View {
        if !account.isEnabled && !Screenshots.on {
            ContentUnavailableView("Trading needs accounts", systemImage: "arrow.left.arrow.right", description: Text("Accounts aren't available yet. Check back soon."))
        } else if !account.isSignedIn && !Screenshots.on {
            ContentUnavailableView {
                Label("Sign in to trade", systemImage: "arrow.left.arrow.right")
            } description: {
                Text("Trading uses your account, the same one as the website. Your collection stays private unless you choose to share it.")
            } actions: {
                Button("Sign in") { signingIn = true }.buttonStyle(.borderedProminent)
            }
        } else if !loaded {
            ProgressView()
        } else if let error, profile == nil {
            ContentUnavailableView("Couldn't load trading", systemImage: "wifi.slash", description: Text(error))
        } else if let profile {
            List {
                Section {
                    Picker("Trade", selection: $tab) {
                        ForEach(Tab.allCases, id: \.self) { t in
                            Text(t == .offers && waiting > 0 ? "Offers (\(waiting))" : t.rawValue).tag(t)
                        }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                switch tab {
                case .traders: TradersSection(me: profile)
                case .list: MyListSection(me: profile)
                case .offers: OffersSection(me: profile, offers: offers)
                }
            }
            .refreshable { await load() }
        } else {
            ProfileForm(existing: nil)
        }
    }

    private func load() async {
        if Screenshots.on {
            profile = TradeSample.me
            offers = TradeSample.offers
            loaded = true
            return
        }
        guard account.isSignedIn else { loaded = true; return }
        do {
            profile = try await TradeAPI.myProfile()
            offers = profile == nil ? [] : (try await TradeAPI.offers())
            error = nil
        } catch {
            self.error = TradeAPI.friendly(error)
        }
        loaded = true
    }
}

// MARK: Profile

struct ProfileForm: View {
    let existing: Trader?
    @Environment(\.dismiss) private var dismiss
    @State private var handle: String
    @State private var name: String
    @State private var area: String
    @State private var bio: String
    @State private var share: Bool
    @State private var busy = false
    @State private var error: String?

    init(existing: Trader?) {
        self.existing = existing
        let fallback = (Account.shared.email ?? "").split(separator: "@").first.map { String($0).lowercased().filter { $0.isLetter || $0.isNumber || $0 == "_" } } ?? ""
        _handle = State(initialValue: existing?.handle ?? String(fallback.prefix(20)))
        _name = State(initialValue: existing?.name ?? "")
        _area = State(initialValue: existing?.area ?? "")
        _bio = State(initialValue: existing?.bio ?? "")
        _share = State(initialValue: existing?.shareCollection ?? false)
    }

    private var valid: Bool { handle.range(of: "^[a-z0-9_]{3,20}$", options: .regularExpression) != nil }

    var body: some View {
        Form {
            Section {
                HStack(spacing: 2) {
                    Text("@").foregroundStyle(.secondary)
                    TextField("username", text: $handle)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: handle) { _, v in
                            let cleaned = String(v.lowercased().filter { $0.isLetter && $0.isASCII || $0.isNumber || $0 == "_" }.prefix(20))
                            if cleaned != v { handle = cleaned }
                        }
                }
                TextField("Name (optional)", text: $name)
                TextField("Area, e.g. Springfield (optional)", text: $area)
                TextField("About you (optional)", text: $bio, axis: .vertical).lineLimit(2...4)
            } header: {
                Text(existing == nil ? "Pick a username other collectors will see" : "What other collectors see")
            } footer: {
                Text("Usernames are 3–20 lowercase letters, numbers or _. A city is enough for the area, so people nearby can meet up.")
            }
            Section {
                Toggle("Share my collection", isOn: $share)
            } footer: {
                Text("Other traders can see the cards in your collection (never what you paid or your notes) and ask for any of them in an offer.")
            }
            if let error {
                Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
            }
            if existing == nil {
                Section {
                    Button { Task { await save() } } label: {
                        HStack { Spacer(); if busy { ProgressView() } else { Text("Start trading").bold() }; Spacer() }
                    }
                    .disabled(!valid || busy)
                }
            }
        }
        .navigationTitle(existing == nil ? "Start trading" : "Your profile")
        .toolbar {
            if existing != nil {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await save() } }.disabled(!valid || busy) }
            }
        }
    }

    private func save() async {
        busy = true
        defer { busy = false }
        do {
            try await TradeAPI.saveProfile(handle: handle, name: name, area: area, bio: bio, share: share, existing: existing != nil)
            if existing != nil { dismiss() }
        } catch {
            self.error = TradeAPI.friendly(error)
        }
    }
}

struct TraderAvatar: View {
    let trader: Trader?
    var size: CGFloat = 40

    var body: some View {
        let seed = (trader?.handle ?? "?").unicodeScalars.reduce(7) { ($0 * 31 + Int($1.value)) % 360 }
        let hue = Double(seed) / 360
        Circle()
            .fill(LinearGradient(colors: [Color(hue: hue, saturation: 0.6, brightness: 0.85), Color(hue: (hue + 0.11).truncatingRemainder(dividingBy: 1), saturation: 0.7, brightness: 0.65)],
                                 startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(width: size, height: size)
            .overlay(Text(String((trader?.name?.isEmpty == false ? trader?.name : trader?.handle)?.prefix(1) ?? "?").uppercased())
                .font(.system(size: size * 0.42, weight: .bold)).foregroundStyle(.white))
            .accessibilityHidden(true)
    }
}

// MARK: Traders

private struct TradersSection: View {
    let me: Trader
    @State private var traders: [Trader] = []
    @State private var counts: [String: (have: Int, want: Int)] = [:]
    @State private var matches: [String: TradeMatch] = [:]
    @State private var finding = false
    @State private var found: (card: CardSummary, rows: [TradeCard], traders: [String: Trader])?
    @State private var query = ""

    var body: some View {
        Section {
            Button { finding = true } label: { Label("Find a card: who has it?", systemImage: "magnifyingglass") }
            TextField("Find a trader", text: $query).textInputAutocapitalization(.never)
        }
        .sheet(isPresented: $finding) { CardPicker(query: "") { c in Task { await find(c.card) } } }
        .task { await load() }
        .onReceive(NotificationCenter.default.publisher(for: .tradeChanged)) { _ in Task { await load() } }

        if let found {
            Section {
                if found.rows.isEmpty {
                    Text("Nobody has it on their trade list yet. Add it to your wants and you'll show up in their matches.").foregroundStyle(.secondary)
                    Button("Add to my wants") { Task { try? await TradeAPI.add("want", [TradeCard(found.card)]) } }
                }
                ForEach(found.rows, id: \.key) { r in
                    if let t = found.traders[r.userId ?? ""] {
                        NavigationLink(value: t) {
                            TraderRow(trader: t, note: [r.grader.map { "\($0) \(r.grade ?? "")" } ?? r.condition, r.quantity > 1 ? "×\(r.quantity)" : nil].compactMap { $0 }.joined(separator: " · "))
                        }
                    }
                }
            } header: {
                HStack { Text("Who has \(found.card.name)"); Spacer(); Button("Clear") { self.found = nil }.font(.caption) }
            }
        }

        let words = query.lowercased().split(separator: " ").map(String.init)
        let shown = traders.filter { t in words.allSatisfy { "\(t.handle) \(t.name ?? "") \(t.area ?? "")".lowercased().contains($0) } }
        let good = shown.filter { matches[$0.userId] != nil }
        let rest = shown.filter { matches[$0.userId] == nil }
        if !good.isEmpty {
            Section("Good matches") {
                ForEach(good) { t in NavigationLink(value: t) { TraderRow(trader: t, counts: counts[t.userId], match: matches[t.userId]) } }
            }
        }
        Section(good.isEmpty ? "Traders" : "Everyone else") {
            if rest.isEmpty && good.isEmpty {
                Text(query.isEmpty ? "No other traders yet. Once friends set up a trading profile they show up here." : "No trader by that name.")
                    .foregroundStyle(.secondary)
            }
            ForEach(rest) { t in NavigationLink(value: t) { TraderRow(trader: t, counts: counts[t.userId]) } }
        }
    }

    private func load() async {
        if Screenshots.on {
            traders = TradeSample.traders
            counts = [TradeSample.misty.userId: (3, 1), TradeSample.brock.userId: (1, 0)]
            matches = [TradeSample.misty.userId: TradeMatch(userId: TradeSample.misty.userId, theyHave: 0, theyWant: 1)]
            return
        }
        do {
            async let list = TradeAPI.traders()
            async let c = TradeAPI.listCounts()
            async let m = TradeAPI.matches()
            traders = try await list.filter { $0.userId != me.userId }
            counts = (try? await c) ?? [:]
            matches = Dictionary(((try? await m) ?? []).map { ($0.userId, $0) }, uniquingKeysWith: { a, _ in a })
        } catch {}
    }

    private func find(_ card: CardSummary) async {
        do {
            let rows = try await TradeAPI.whoHas(card.id).filter { $0.userId != me.userId }
            let ts = try await TradeAPI.traders(ids: Array(Set(rows.compactMap(\.userId))))
            found = (card, rows, Dictionary(ts.map { ($0.userId, $0) }, uniquingKeysWith: { a, _ in a }))
        } catch {}
    }
}

private struct TraderRow: View {
    let trader: Trader
    var counts: (have: Int, want: Int)? = nil
    var match: TradeMatch? = nil
    var note: String? = nil

    var body: some View {
        HStack(spacing: 12) {
            TraderAvatar(trader: trader)
            VStack(alignment: .leading, spacing: 2) {
                Text(trader.displayName).font(.headline)
                Text("@\(trader.handle)\(trader.area.map { " · \($0)" } ?? "")").font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                if let match {
                    Text([match.theyHave > 0 ? "Has \(match.theyHave) you want" : nil, match.theyWant > 0 ? "Wants \(match.theyWant) you have" : nil].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption.weight(.semibold)).foregroundStyle(Color.up)
                }
            }
            Spacer(minLength: 6)
            if let note {
                Text(note).font(.caption).foregroundStyle(.secondary)
            } else if let counts, counts.have > 0 {
                Text("\(counts.have) for trade").font(.caption).foregroundStyle(.secondary)
            } else if trader.shareCollection {
                Text("Collection shared").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: My list

private struct MyListSection: View {
    let me: Trader
    @Query(filter: #Predicate<Holding> { $0.isTombstoned == false }) private var holdings: [Holding]
    @State private var cards: [TradeCard] = []
    @State private var kind = "have"
    @State private var pickingMine = false
    @State private var pickingAny = false
    @State private var share: Bool
    @State private var busy = false
    @State private var confirmAll = false

    init(me: Trader) {
        self.me = me
        _share = State(initialValue: me.shareCollection)
    }

    var body: some View {
        let rows = cards.filter { $0.kind == kind }
        Section {
            Toggle(isOn: $share) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Share my whole collection")
                    Text(share ? "Traders can see every card in your collection, never what you paid or your notes." : "Off: traders only see the cards on your list.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .onChange(of: share) { _, on in
                Task { try? await TradeAPI.saveProfile(handle: me.handle, name: me.name ?? "", area: me.area ?? "", bio: me.bio ?? "", share: on, existing: true) }
            }
        }
        .task { await load() }
        .onReceive(NotificationCenter.default.publisher(for: .tradeChanged)) { _ in Task { await load() } }
        .sheet(isPresented: $pickingMine) {
            HoldingPicker(title: "Add from your collection", hidden: Set(cards.filter { $0.kind == "have" }.compactMap(\.holdingId))) { picked in
                Task { try? await TradeAPI.add("have", picked) }
            }
        }
        .sheet(isPresented: $pickingAny) { CardPicker(query: "") { c in Task { try? await TradeAPI.add(kind, [TradeCard(c.card)]) } } }
        .confirmationDialog("List your whole collection for trade?", isPresented: $confirmAll, titleVisibility: .visible) {
            Button("List \(unlisted.count) cards") { Task { await listEverything() } }
        } message: {
            Text("You can take any of them off the list later.")
        }

        Section {
            Picker("List", selection: $kind) {
                Text("For trade (\(cards.filter { $0.kind == "have" }.count))").tag("have")
                Text("Wanted (\(cards.filter { $0.kind == "want" }.count))").tag("want")
            }
            .pickerStyle(.segmented)
            if kind == "have" {
                Button { pickingMine = true } label: { Label("From my collection", systemImage: "square.stack.3d.up") }
            }
            Button { pickingAny = true } label: { Label("Any card", systemImage: "plus") }
            if kind == "have" && !unlisted.isEmpty {
                Button { confirmAll = true } label: { Label("List my whole collection", systemImage: "rectangle.stack.badge.plus") }.disabled(busy)
            }
        } footer: {
            let total = TradeAPI.total(rows)
            Text(kind == "have" ? "Pick from your collection, or add any card without scanning.\(rows.isEmpty ? "" : " Worth \(Fmt.money(total)).")" : "Cards you're looking for. Traders who have them show up under Good matches.")
        }

        Section {
            if rows.isEmpty {
                Text(kind == "have" ? "Nothing listed for trade yet." : "No wants yet.").foregroundStyle(.secondary)
            }
            ForEach(rows, id: \.key) { c in
                TradeCardRow(card: c)
                    .swipeActions { Button(role: .destructive) { Task { try? await TradeAPI.remove([c.id].compactMap { $0 }) } } label: { Label("Remove", systemImage: "trash") } }
            }
        }
    }

    private var unlisted: [Holding] {
        let listed = Set(cards.filter { $0.kind == "have" }.compactMap(\.holdingId))
        return holdings.filter { !listed.contains($0.id.uuidString.lowercased()) }
    }

    private func load() async {
        if Screenshots.on { cards = await TradeAPI.withValues(TradeSample.myList); return }
        guard let list = try? await TradeAPI.list(of: me.userId) else { return }
        cards = await TradeAPI.withValues(list)
    }

    private func listEverything() async {
        busy = true
        defer { busy = false }
        try? await TradeAPI.add("have", unlisted.map { TradeCard($0) })
    }
}

struct TradeCardRow: View {
    let card: TradeCard
    var badge: String? = nil

    var body: some View {
        HStack(spacing: 12) {
            CardImage(url: card.imageURL, name: card.name, game: .pokemon, corner: 4).frame(width: 42)
                .chineseBanner(card.language == "zh")
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(card.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                    if card.quantity > 1 { Text("×\(card.quantity)").font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
                }
                Text(card.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                if let badge {
                    Text(badge).font(.caption2.weight(.bold)).foregroundStyle(.white)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.up, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                }
            }
            Spacer(minLength: 6)
            Text(card.value.map { Fmt.money($0 * Double(card.quantity)) } ?? "—").font(.subheadline.weight(.semibold)).monospacedDigit()
        }
    }
}

/// Choose cards from your own collection.
struct HoldingPicker: View {
    let title: String
    var hidden: Set<String> = []
    var onDone: ([TradeCard]) -> Void
    @Environment(\.dismiss) private var dismiss
    @Query(filter: #Predicate<Holding> { $0.isTombstoned == false }) private var holdings: [Holding]
    @State private var picked: Set<UUID> = []
    @State private var query = ""

    var body: some View {
        let words = query.lowercased().split(separator: " ").map(String.init)
        let shown = holdings.filter { !hidden.contains($0.id.uuidString.lowercased()) }
            .filter { h in words.allSatisfy { "\(h.name) \(h.setName ?? "") \(h.number ?? "")".lowercased().contains($0) } }
            .sorted { ($0.totalValue ?? 0) > ($1.totalValue ?? 0) }
        NavigationStack {
            List {
                if shown.isEmpty {
                    Text(holdings.isEmpty ? "Your collection is empty. Use Any card instead." : "No cards match.").foregroundStyle(.secondary)
                }
                ForEach(shown.prefix(400)) { h in
                    Button {
                        if picked.contains(h.id) { picked.remove(h.id) } else { picked.insert(h.id) }
                    } label: {
                        HStack {
                            TradeCardRow(card: TradeCard(h))
                            Image(systemName: picked.contains(h.id) ? "checkmark.circle.fill" : "circle")
                                .font(.title3).foregroundStyle(picked.contains(h.id) ? Color.accentColor : Color.secondary.opacity(0.5))
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .listStyle(.plain)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search your cards")
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(picked.isEmpty ? "Add" : "Add \(picked.count)") {
                        onDone(holdings.filter { picked.contains($0.id) }.map { TradeCard($0) })
                        dismiss()
                    }
                    .disabled(picked.isEmpty)
                }
            }
        }
    }
}

// MARK: A trader's page

struct TraderView: View {
    let trader: Trader
    let me: Trader?
    @State private var haves: [TradeCard] = []
    @State private var wants: [TradeCard] = []
    @State private var collection: [TradeCard] = []
    @State private var myWants: Set<String> = []
    @State private var myHaves: Set<String> = []
    @State private var tab = "have"
    @State private var picked: [TradeCard] = []
    @State private var composing = false

    private var isMe: Bool { me?.userId == trader.userId }
    private var shown: [TradeCard] { tab == "have" ? haves : tab == "want" ? wants : collection }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 14) {
                    TraderAvatar(trader: trader, size: 60)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(trader.displayName).font(.title2.bold())
                        Text("@\(trader.handle)\(trader.area.map { " · \($0)" } ?? "")").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                if let bio = trader.bio, !bio.isEmpty { Text(bio).font(.subheadline) }
                Picker("Cards", selection: $tab) {
                    Text("For trade (\(haves.count))").tag("have")
                    Text("Wants (\(wants.count))").tag("want")
                    if trader.shareCollection { Text("Collection (\(collection.count))").tag("collection") }
                }
                .pickerStyle(.segmented)
                if !isMe {
                    Text(tab == "want" ? "Cards they're looking for. \"On your list\" means it's on your trade list." : "Tap the cards you'd like, then make an offer. You can also ask for any card, or offer cash.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if shown.isEmpty {
                    Text(tab == "want" ? "No wants listed." : "Nothing listed here. You can still make an offer and ask for any card.")
                        .foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical, 30)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 12)], spacing: 16) {
                    ForEach(shown, id: \.key) { c in
                        let isPicked = picked.contains { $0.same(c) }
                        Button {
                            guard tab != "want", !isMe else { return }
                            if isPicked { picked.removeAll { $0.same(c) } } else { var one = c; one.quantity = 1; picked.append(one) }
                        } label: {
                            TradeTile(card: c, picked: isPicked,
                                      badge: tab == "want" ? (myHaves.contains(c.cardId) ? "On your list" : nil) : (myWants.contains(c.cardId) ? "You want" : nil))
                        }
                        .buttonStyle(.plain)
                        .sensoryFeedback(.selection, trigger: isPicked)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 100)
        }
        .navigationTitle(trader.handle)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            if !isMe, me != nil {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(picked.isEmpty ? "Pick cards, or start an offer" : "\(picked.count) card\(picked.count == 1 ? "" : "s") picked")
                            .font(.subheadline.weight(.semibold))
                        if !picked.isEmpty { Text(Fmt.money(TradeAPI.total(picked))).font(.caption).foregroundStyle(.secondary).monospacedDigit() }
                    }
                    Spacer()
                    Button("Make an offer") { composing = true }.buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
                }
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(.bar)
            }
        }
        .task { await load() }
        .sheet(isPresented: $composing) {
            OfferComposer(other: trader, initialGet: picked, theirCards: haves + collection) { picked = [] }
        }
    }

    private func load() async {
        if Screenshots.on {
            haves = await TradeAPI.withValues(TradeSample.mistyList)
            collection = await TradeAPI.withValues(TradeSample.mistyCollection)
            wants = [TradeSample.pikachu]
            myHaves = [TradeSample.pikachu.cardId]
            return
        }
        guard let list = try? await TradeAPI.list(of: trader.userId) else { return }
        haves = await TradeAPI.withValues(list.filter { $0.kind == "have" })
        wants = await TradeAPI.withValues(list.filter { $0.kind == "want" })
        if trader.shareCollection, let c = try? await TradeAPI.sharedCollection(of: trader.userId) { collection = await TradeAPI.withValues(c) }
        if let me, let mine = try? await TradeAPI.list(of: me.userId) {
            myWants = Set(mine.filter { $0.kind == "want" }.map(\.cardId))
            myHaves = Set(mine.filter { $0.kind == "have" }.map(\.cardId))
        }
    }
}

private struct TradeTile: View {
    let card: TradeCard
    var picked = false
    var badge: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            CardImage(url: card.imageURL, name: card.name, game: .pokemon, corner: 6)
                .aspectRatio(63 / 88, contentMode: .fit)
                .chineseBanner(card.language == "zh")
                .overlay {
                    RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Color.accentColor, lineWidth: picked ? 3 : 0)
                }
                .overlay(alignment: .topTrailing) {
                    if picked {
                        Image(systemName: "checkmark.circle.fill").font(.title3).symbolRenderingMode(.palette)
                            .foregroundStyle(.white, Color.accentColor).padding(4)
                    }
                }
                .overlay(alignment: .bottomLeading) {
                    if let badge {
                        Text(badge).font(.caption2.weight(.bold)).foregroundStyle(.white)
                            .padding(.horizontal, 5).padding(.vertical, 2)
                            .background(Color.up, in: RoundedRectangle(cornerRadius: 5, style: .continuous)).padding(4)
                    }
                }
                .cardShadow()
                .scaleEffect(picked ? 0.96 : 1)
                .animation(.snappy, value: picked)
            Text(card.name).font(.caption.weight(.semibold)).lineLimit(2)
            HStack(spacing: 4) {
                if let v = card.value { Text(Fmt.money(v)).monospacedDigit() }
                if let g = card.grader { Text("\(g) \(card.grade ?? "")").foregroundStyle(.red) }
            }
            .font(.caption2).foregroundStyle(.secondary)
        }
    }
}

// MARK: Making an offer

struct OfferComposer: View {
    let other: Trader
    var initialGive: [TradeCard] = []
    var initialGet: [TradeCard] = []
    var initialCash: Double = 0
    var counterOf: String? = nil
    var theirCards: [TradeCard]? = nil
    var onSent: () -> Void = {}
    @Environment(\.dismiss) private var dismiss
    @State private var give: [TradeCard] = []
    @State private var get: [TradeCard] = []
    @State private var cashMode = "none"
    @State private var cash = ""
    @State private var message = ""
    @State private var their: [TradeCard] = []
    @State private var pickingMine = false
    @State private var pickingAny: String?
    @State private var busy = false
    @State private var error: String?
    @State private var started = false

    private var cashValue: Double { cashMode == "none" ? 0 : (Double(cash.replacingOccurrences(of: ",", with: ".")) ?? 0) * (cashMode == "add" ? 1 : -1) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if give.isEmpty { Text("No cards yet").foregroundStyle(.secondary) }
                    ForEach($give, id: \.key) { $c in EditableLine(card: $c) }
                        .onDelete { give.remove(atOffsets: $0) }
                    Button { pickingMine = true } label: { Label("From my collection", systemImage: "square.stack.3d.up") }
                    Button { pickingAny = "give" } label: { Label("Any card", systemImage: "plus") }
                } header: {
                    SideHeader(title: "You give", total: TradeAPI.total(give))
                }

                Section {
                    if get.isEmpty { Text("No cards yet").foregroundStyle(.secondary) }
                    ForEach($get, id: \.key) { $c in EditableLine(card: $c) }
                        .onDelete { get.remove(atOffsets: $0) }
                    Button { pickingAny = "get" } label: { Label("Any card", systemImage: "plus") }
                    let suggestions = their.filter { c in !get.contains { $0.same(c) } }.prefix(24)
                    if !suggestions.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                ForEach(Array(suggestions), id: \.key) { c in
                                    Button { withAnimation(.snappy) { var one = c; one.quantity = 1; get.append(one) } } label: {
                                        VStack(alignment: .leading, spacing: 3) {
                                            CardImage(url: c.imageURL, name: c.name, game: .pokemon, corner: 4).frame(width: 64)
                                            Text(c.name).font(.caption2).lineLimit(1).frame(width: 64, alignment: .leading)
                                            Text(Fmt.money(c.value)).font(.caption2).foregroundStyle(.secondary).monospacedDigit()
                                        }
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                } header: {
                    SideHeader(title: "You get from \(other.displayName)", total: TradeAPI.total(get))
                } footer: {
                    if !their.isEmpty { Text("Tap one of their cards to ask for it.") }
                }

                Section("Cash") {
                    Picker("Cash", selection: $cashMode) {
                        Text("No cash").tag("none")
                        Text("I add").tag("add")
                        Text("I ask for").tag("ask")
                    }
                    .pickerStyle(.segmented)
                    if cashMode != "none" {
                        HStack {
                            Text("$").foregroundStyle(.secondary)
                            TextField("0", text: $cash).keyboardType(.decimalPad)
                        }
                    }
                }

                Section {
                    TradeBalance(give: TradeAPI.total(give) + max(0, cashValue), get: TradeAPI.total(get) + max(0, -cashValue))
                }

                Section {
                    TextField("Condition notes, where to meet, shipping…", text: $message, axis: .vertical).lineLimit(2...5)
                } header: {
                    Text("Message (optional)")
                } footer: {
                    Text("Values are today's market prices. \(other.displayName) can accept, decline or counter. Nothing changes in either collection.")
                }

                if let error {
                    Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
                }
            }
            .navigationTitle(counterOf == nil ? "Offer to \(other.displayName)" : "Counteroffer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Sending…" : "Send") { Task { await send() } }
                        .bold()
                        .disabled(busy || (give.isEmpty && get.isEmpty))
                }
            }
            .sheet(isPresented: $pickingMine) {
                HoldingPicker(title: "Cards you'll give") { cards in add(cards, to: "give") }
            }
            .sheet(item: Binding(get: { pickingAny.map { PickSide(side: $0) } }, set: { pickingAny = $0?.side })) { p in
                CardPicker(query: "") { c in add([TradeCard(c.card)], to: p.side) }
            }
            .task {
                guard !started else { return }
                started = true
                give = await TradeAPI.withValues(initialGive)
                get = await TradeAPI.withValues(initialGet)
                if initialCash != 0 { cashMode = initialCash > 0 ? "add" : "ask"; cash = String(format: "%g", abs(initialCash)) }
                if let theirCards { their = theirCards } else { await loadTheirs() }
            }
        }
    }

    private struct PickSide: Identifiable { let side: String; var id: String { side } }

    private func add(_ cards: [TradeCard], to side: String) {
        Task {
            let valued = await TradeAPI.withValues(cards.map { var c = $0; c.quantity = 1; return c })
            withAnimation(.snappy) {
                if side == "give" { give += valued.filter { c in !give.contains { $0.same(c) } } }
                else { get += valued.filter { c in !get.contains { $0.same(c) } } }
            }
        }
    }

    private func loadTheirs() async {
        guard let list = try? await TradeAPI.list(of: other.userId) else { return }
        var cards = list.filter { $0.kind == "have" }
        if other.shareCollection, let c = try? await TradeAPI.sharedCollection(of: other.userId) { cards += c }
        their = await TradeAPI.withValues(cards)
    }

    private func send() async {
        busy = true
        defer { busy = false }
        do {
            try await TradeAPI.send(to: other.userId, give: give, get: get, cash: cashValue, message: message, counterOf: counterOf)
            onSent()
            dismiss()
        } catch {
            self.error = TradeAPI.friendly(error)
        }
    }
}

private struct SideHeader: View {
    let title: String
    let total: Double
    var body: some View {
        HStack { Text(title); Spacer(); Text(Fmt.money(total)).monospacedDigit() }
    }
}

private struct EditableLine: View {
    @Binding var card: TradeCard
    var body: some View {
        HStack(spacing: 10) {
            CardImage(url: card.imageURL, name: card.name, game: .pokemon, corner: 4).frame(width: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(card.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(card.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            Stepper("×\(card.quantity)", value: $card.quantity, in: 1...99).labelsHidden().fixedSize()
            VStack(alignment: .trailing, spacing: 0) {
                Text(card.value.map { Fmt.money($0 * Double(card.quantity)) } ?? "—").font(.subheadline.weight(.semibold)).monospacedDigit()
                if card.quantity > 1 { Text("×\(card.quantity)").font(.caption2).foregroundStyle(.secondary) }
            }
            .frame(minWidth: 58, alignment: .trailing)
        }
    }
}

/// Who gives more: a bar and a plain verdict.
struct TradeBalance: View {
    let give: Double
    let get: Double

    var body: some View {
        let total = max(give + get, 1)
        let diff = give - get
        let even = abs(diff) <= max(1, total * 0.03)
        VStack(spacing: 8) {
            GeometryReader { geo in
                HStack(spacing: 2) {
                    Capsule().fill(Color.accentColor).frame(width: max(4, geo.size.width * give / total))
                    Capsule().fill(Color.up).frame(width: max(4, geo.size.width * get / total))
                }
            }
            .frame(height: 8)
            .animation(.snappy, value: give)
            .animation(.snappy, value: get)
            HStack {
                VStack(alignment: .leading, spacing: 1) { Text("You give").font(.caption).foregroundStyle(.secondary); Text(Fmt.money(give)).bold().monospacedDigit() }
                Spacer()
                Text(even ? "About even" : diff > 0 ? "You give \(Fmt.money(diff)) more" : "You get \(Fmt.money(-diff)) more")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(even ? Color.up : diff > 0 ? Color.orange : Color.accentColor)
                    .multilineTextAlignment(.center)
                Spacer()
                VStack(alignment: .trailing, spacing: 1) { Text("You get").font(.caption).foregroundStyle(.secondary); Text(Fmt.money(get)).bold().monospacedDigit() }
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: Offers

private struct OffersSection: View {
    let me: Trader
    let offers: [TradeOffer]
    @State private var box = "received"
    @State private var people: [String: Trader] = [:]
    @State private var open: TradeOffer?

    var body: some View {
        let shown = offers.filter { o in
            box == "past" ? o.status != .open : o.status == .open && (box == "received" ? o.toUser == me.userId : o.fromUser == me.userId)
        }
        Section {
            Picker("Offers", selection: $box) {
                Text("Received").tag("received")
                Text("Sent").tag("sent")
                Text("Past").tag("past")
            }
            .pickerStyle(.segmented)
        }
        .task(id: offers.map(\.id).joined()) { await loadPeople() }
        .sheet(item: $open) { o in OfferDetail(offer: o, me: me, other: people[o.view(for: me.userId).other]) }

        Section {
            if shown.isEmpty {
                Text(box == "received" ? "No offers waiting. Offers other traders send you show up here." : box == "sent" ? "No offers out. Open a trader, pick cards and make an offer." : "Accepted, declined and cancelled offers show up here.")
                    .foregroundStyle(.secondary)
            }
            ForEach(shown) { o in
                let v = o.view(for: me.userId)
                Button { open = o } label: {
                    HStack(spacing: 12) {
                        TraderAvatar(trader: people[v.other])
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                Text(people[v.other]?.displayName ?? "Trader").font(.headline)
                                StatusPill(offer: o, me: me.userId)
                            }
                            Text("\(o.parentId != nil ? "Counteroffer · " : "")You give \(v.youGive.count) · get \(v.youGet.count)\(v.cashOut != 0 ? " · \(v.cashOut > 0 ? "+" : "−")\(Fmt.money(abs(v.cashOut))) cash" : "")")
                                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            Text(Date(timeIntervalSince1970: o.updatedAt / 1000).formatted(.relative(presentation: .named)))
                                .font(.caption2).foregroundStyle(.tertiary)
                        }
                        Spacer(minLength: 4)
                        let worth = TradeAPI.total(v.youGet) + max(0, -v.cashOut)
                        if worth > 0 {
                            VStack(alignment: .trailing, spacing: 1) {
                                Text(Fmt.money(worth)).font(.subheadline.weight(.semibold)).monospacedDigit()
                                Text("you get").font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func loadPeople() async {
        if Screenshots.on { people = Dictionary(TradeSample.traders.map { ($0.userId, $0) }, uniquingKeysWith: { a, _ in a }); return }
        let ids = Set(offers.flatMap { [$0.fromUser, $0.toUser] })
        if let ts = try? await TradeAPI.traders(ids: Array(ids)) { people = Dictionary(ts.map { ($0.userId, $0) }, uniquingKeysWith: { a, _ in a }) }
    }
}

private struct StatusPill: View {
    let offer: TradeOffer
    let me: String
    var body: some View {
        let color: Color = switch offer.status {
        case .open: .accentColor
        case .accepted: .up
        case .declined: .down
        default: .secondary
        }
        Text(offer.statusLabel(for: me))
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.14), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
    }
}

struct OfferDetail: View {
    let offer: TradeOffer
    let me: Trader
    let other: Trader?
    @Environment(\.dismiss) private var dismiss
    @State private var youGive: [TradeCard] = []
    @State private var youGet: [TradeCard] = []
    @State private var status: TradeOffer.Status
    @State private var messages: [TradeMessage] = []
    @State private var text = ""
    @State private var busy = false
    @State private var countering = false
    @State private var error: String?
    @State private var confirm: String?

    init(offer: TradeOffer, me: Trader, other: Trader?) {
        self.offer = offer
        self.me = me
        self.other = other
        _status = State(initialValue: offer.status)
    }

    var body: some View {
        let v = offer.view(for: me.userId)
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 12) {
                        TraderAvatar(trader: other, size: 44)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(other?.displayName ?? "Trader").font(.headline)
                            Text("\(offer.parentId != nil ? "Counteroffer · " : "")sent \(Date(timeIntervalSince1970: offer.createdAt / 1000).formatted(.relative(presentation: .named)))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        StatusPill(offer: TradeOffer(id: offer.id, fromUser: offer.fromUser, toUser: offer.toUser, parentId: offer.parentId, status: status, give: [], get: [], cash: 0, message: nil, createdAt: 0, updatedAt: 0), me: me.userId)
                    }
                }
                Section {
                    ForEach(youGive, id: \.key) { TradeCardRow(card: $0) }
                    if v.cashOut > 0 { CashRow(amount: v.cashOut) }
                    if youGive.isEmpty && v.cashOut <= 0 { Text("Nothing").foregroundStyle(.secondary) }
                } header: { SideHeader(title: "You give", total: TradeAPI.total(youGive) + max(0, v.cashOut)) }
                Section {
                    ForEach(youGet, id: \.key) { TradeCardRow(card: $0) }
                    if v.cashOut < 0 { CashRow(amount: -v.cashOut) }
                    if youGet.isEmpty && v.cashOut >= 0 { Text("Nothing").foregroundStyle(.secondary) }
                } header: { SideHeader(title: "You get", total: TradeAPI.total(youGet) + max(0, -v.cashOut)) }
                Section {
                    TradeBalance(give: TradeAPI.total(youGive) + max(0, v.cashOut), get: TradeAPI.total(youGet) + max(0, -v.cashOut))
                } footer: {
                    if status == .accepted {
                        Text("Deal agreed. Use the messages to set up the swap. Nothing was moved in either collection: add or remove the cards yourselves once you've traded.")
                    }
                }

                Section("Messages") {
                    if let m = offer.message { Bubble(mine: v.sent, text: m, at: offer.createdAt) }
                    ForEach(messages) { m in Bubble(mine: m.fromUser == me.userId, text: m.body, at: m.createdAt) }
                    if messages.isEmpty && offer.message == nil { Text("No messages yet.").foregroundStyle(.secondary) }
                    HStack {
                        TextField("Message \(other?.displayName ?? "them")", text: $text, axis: .vertical).lineLimit(1...4)
                        Button { Task { await say() } } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                .listRowSeparator(.hidden)

                if let error {
                    Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
                }
            }
            .navigationTitle(v.sent ? "Your offer" : "Offer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                if status == .open {
                    ToolbarItemGroup(placement: .bottomBar) {
                        if v.sent {
                            Button("Cancel offer", role: .destructive) { confirm = "cancel" }.disabled(busy)
                        } else {
                            Button("Decline", role: .destructive) { confirm = "decline" }.disabled(busy)
                            Spacer()
                            Button("Counter") { countering = true }.disabled(busy || other == nil)
                            Spacer()
                            Button("Accept") { Task { await act("accept") } }.bold().disabled(busy)
                        }
                    }
                }
            }
            .confirmationDialog(confirm == "cancel" ? "Cancel this offer?" : "Decline this offer?", isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
                Button(confirm == "cancel" ? "Cancel offer" : "Decline", role: .destructive) { if let c = confirm { Task { await act(c) } } }
            }
            .sheet(isPresented: $countering) {
                if let other {
                    OfferComposer(other: other, initialGive: v.youGive, initialGet: v.youGet, initialCash: v.cashOut, counterOf: offer.id) { dismiss() }
                }
            }
            .task {
                youGive = await TradeAPI.withValues(v.youGive.map { var c = $0; c.value = nil; return c })
                youGet = await TradeAPI.withValues(v.youGet.map { var c = $0; c.value = nil; return c })
                await loadMessages()
            }
        }
    }

    private func loadMessages() async {
        if Screenshots.on { messages = TradeSample.messages; return }
        if let m = try? await TradeAPI.messages(offer.id) { messages = m }
    }

    private func say() async {
        let body = text
        text = ""
        do { try await TradeAPI.say(offer.id, body); await loadMessages() } catch { text = body; self.error = TradeAPI.friendly(error) }
    }

    private func act(_ action: String) async {
        busy = true
        defer { busy = false }
        do {
            try await TradeAPI.respond(offer.id, action)
            status = action == "accept" ? .accepted : action == "decline" ? .declined : .cancelled
        } catch {
            self.error = TradeAPI.friendly(error)
        }
    }
}

private struct CashRow: View {
    let amount: Double
    var body: some View {
        HStack(spacing: 12) {
            Text("$").font(.headline).foregroundStyle(Color.up).frame(width: 42, height: 42)
                .background(Color.up.opacity(0.14), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            Text("Cash").font(.subheadline.weight(.semibold))
            Spacer()
            Text(Fmt.money(amount)).font(.subheadline.weight(.semibold)).monospacedDigit()
        }
    }
}

private struct Bubble: View {
    let mine: Bool
    let text: String
    let at: Double
    var body: some View {
        HStack {
            if mine { Spacer(minLength: 40) }
            VStack(alignment: mine ? .trailing : .leading, spacing: 2) {
                Text(text).font(.subheadline)
                Text(Date(timeIntervalSince1970: at / 1000).formatted(date: .abbreviated, time: .shortened)).font(.caption2).opacity(0.7)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .foregroundStyle(mine ? Color.white : Color.primary)
            .background(mine ? Color.accentColor : Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            if !mine { Spacer(minLength: 40) }
        }
    }
}

// MARK: Sample data for the screenshots

enum TradeSample {
    static let me = Trader(userId: "a", handle: "ash_k", name: "Ash", area: "Springfield", bio: nil, shareCollection: false, createdAt: Date().timeIntervalSince1970 * 1000)
    static let misty = Trader(userId: "b", handle: "misty_trades", name: "Misty", area: "Shelbyville", bio: "Water types and alt arts. Meet at the Shelbyville card shop on weekends.", shareCollection: true, createdAt: (Date().timeIntervalSince1970 - 90 * 86400) * 1000)
    static let brock = Trader(userId: "c", handle: "brock", name: "Brock", area: "Springfield", bio: nil, shareCollection: false, createdAt: Date().timeIntervalSince1970 * 1000)
    static let traders = [misty, brock]
    static let pikachu = TradeCard(cardId: "tcg:250303", name: "Pikachu", setName: "Celebrations", number: "005", image: "https://tcgplayer-cdn.tcgplayer.com/product/250303_200w.jpg")
    static let mistyList = [
        TradeCard(cardId: "tcg:246723", name: "Umbreon VMAX (Alternate Art Secret)", setName: "Evolving Skies", number: "215", image: "https://tcgplayer-cdn.tcgplayer.com/product/246723_200w.jpg"),
        TradeCard(cardId: "tcg:509980", name: "Charizard ex", setName: "Obsidian Flames", number: "223", image: "https://tcgplayer-cdn.tcgplayer.com/product/509980_200w.jpg"),
        TradeCard(cardId: "tcg:517051", name: "Mew ex", setName: "Scarlet & Violet 151", number: "205", image: "https://tcgplayer-cdn.tcgplayer.com/product/517051_200w.jpg", grader: "PSA", grade: "10"),
    ]
    static let mistyCollection = [TradeCard(cardId: "tcg:246733", name: "Rayquaza VMAX (Alternate Art Secret)", setName: "Evolving Skies", number: "218", image: "https://tcgplayer-cdn.tcgplayer.com/product/246733_200w.jpg")]
    static let myList = [pikachu]
    static let offers: [TradeOffer] = {
        let now = Date().timeIntervalSince1970 * 1000
        return [
            TradeOffer(id: "o1", fromUser: "b", toUser: "a", parentId: nil, status: .open, give: [{ var c = mistyList[1]; c.value = 85.74; return c }()], get: [{ var p = pikachu; p.quantity = 2; p.value = 3.97; return p }()],
                       cash: 0, message: "Hey! Would you do two of your Pikachus for my Charizard?", createdAt: now - 3 * 3_600_000, updatedAt: now - 3 * 3_600_000),
            TradeOffer(id: "o2", fromUser: "a", toUser: "c", parentId: nil, status: .accepted, give: [pikachu], get: [], cash: -5, message: nil, createdAt: now - 50 * 3_600_000, updatedAt: now - 30 * 3_600_000),
        ]
    }()
    static let messages = [TradeMessage(id: "m1", offerId: "o1", fromUser: "a", body: "Maybe! What condition is it in?", createdAt: Date().timeIntervalSince1970 * 1000 - 2 * 3_600_000)]
}
