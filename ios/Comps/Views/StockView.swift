import SwiftUI

/// Which nearby stores have Pokémon card product, from the checks that run every 15 minutes.
/// The same screen as the website's Stock page.
@MainActor
struct StockView: View {
    private var model: StockModel { StockModel.shared }
    @AppStorage("stock.view") private var grouping = "store"
    @AppStorage("stock.chain") private var chain: String?
    /// 0 means as far as the checks reach.
    @AppStorage("stock.miles") private var miles = 0
    @AppStorage("stock.inStockOnly") private var inStockOnly = true
    @State private var query = ""
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Stock")
                .topBarButtons()
        }
        .task { await model.load() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.load() } }
        }
    }

    @ViewBuilder private var content: some View {
        if let doc = model.doc {
            list(doc)
        } else {
            switch model.phase {
            case .loading, .ready:
                ProgressView()
            case .notSetUp:
                ContentUnavailableView("Stock checks aren't on yet", systemImage: "storefront",
                                       description: Text("Once they are, this lists which stores near you have Pokémon cards, checked every 15 minutes."))
            case .failed:
                ContentUnavailableView {
                    Label("Couldn't load the stock list", systemImage: "wifi.slash")
                } description: {
                    Text("Check your connection. The last answer comes back as soon as it's reachable.")
                } actions: {
                    Button("Try again") { Task { await model.load(force: true) } }.buttonStyle(.bordered)
                }
            }
        }
    }

    private func list(_ doc: StockDoc) -> some View {
        let reach = max(5, Int(doc.radius.rounded()))
        let range = miles > 0 ? min(miles, reach) : reach
        let chosen = chain.flatMap { doc.chains[$0] == nil ? nil : $0 }
        let filter = StockFilter(chain: chosen, miles: Double(range), inStockOnly: inStockOnly, query: query.trimmingCharacters(in: .whitespaces))
        let stores = grouping == "store" ? Stock.byStore(doc, filter) : []
        let products = grouping == "store" ? [] : Stock.byProduct(doc, filter)
        let chains = doc.chains.sorted { $0.value.name < $1.value.name }
        let chips: [(String?, String)] = [(nil, "All stores")] + chains.map { (Optional($0.key), $0.value.name) }
        let failures: [String] = chains.filter { !$0.value.ok }.map { item in
            let reason = item.value.error.map { ": " + $0 } ?? ""
            return item.value.name + " couldn't be checked" + reason + "."
        }
        let checked = Date(timeIntervalSince1970: doc.updatedAt / 1000)
        let stale = Date().timeIntervalSince(checked) > 2 * 3600

        return List {
            Section {
                Picker("Group by", selection: $grouping) {
                    Text("By store").tag("store")
                    Text("By product").tag("product")
                }
                .pickerStyle(.segmented)
                .listRowSeparator(.hidden)
                Picker("Distance", selection: Binding(get: { range }, set: { miles = $0 })) {
                    ForEach(Stock.radiusOptions(reach), id: \.self) { Text("\($0) mi").tag($0) }
                }
                .pickerStyle(.segmented)
                .listRowSeparator(.hidden)
                if chains.count > 1 {
                    ChipBar(options: chips, selection: $chain)
                        .listRowSeparator(.hidden)
                }
                if grouping == "store" {
                    Toggle("In stock only", isOn: $inStockOnly)
                }
            } footer: {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Pokémon cards at stores within \(reach) miles. Checked \(checked.formatted(.relative(presentation: .named))).")
                        .foregroundStyle(stale ? Color.orange : Color.secondary)
                    ForEach(failures, id: \.self) { message in
                        Label(message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    }
                }
            }

            if grouping == "store" {
                ForEach(stores) { group in
                    Section { storeRows(group) }
                }
            } else {
                ForEach(products) { group in
                    Section { productRows(group) }
                }
            }

            if stores.isEmpty && products.isEmpty {
                ContentUnavailableView {
                    Label(filter.query.isEmpty ? "Nothing in stock within \(range) miles" : "No “\(filter.query)” in stock nearby", systemImage: "storefront")
                } description: {
                    Text(range < reach ? "Try a wider distance." : "This list updates on its own every 15 minutes.")
                }
                .listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped)
        .searchable(text: $query, prompt: "Find a product")
        .refreshable { await model.load(force: true) }
        .animation(.snappy, value: grouping)
        .animation(.snappy, value: inStockOnly)
    }

    // MARK: Rows

    @ViewBuilder private func storeRows(_ group: StockStoreGroup) -> some View {
        let s = group.store
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(s.name).font(.headline)
                Text(subtitle(group.chainName, s)).font(.subheadline).foregroundStyle(.secondary)
                if s.suspect != nil {
                    Text("Counts often wrong here")
                        .font(.caption.weight(.semibold)).foregroundStyle(.orange)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Color.orange.opacity(0.14), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
            }
            Spacer(minLength: 8)
            Button { openMaps(group.chainName, s) } label: {
                Label(Stock.miles(s.distance) ?? "Map", systemImage: "mappin.and.ellipse")
                    .font(.footnote.weight(.semibold).monospacedDigit())
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .controlSize(.small)
            .accessibilityLabel("Directions to \(group.chainName) \(s.name)")
        }
        if group.items.isEmpty {
            Text("Nothing in stock at the last check.").font(.subheadline).foregroundStyle(.secondary)
        }
        ForEach(group.items) { line in
            Button { open(line.product.url) } label: {
                HStack(alignment: .top, spacing: 12) {
                    StockPicture(url: line.product.image, name: line.product.name)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(line.product.name).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).multilineTextAlignment(.leading)
                        StockSince(entry: line.entry, exact: group.exact)
                    }
                    Spacer(minLength: 8)
                    VStack(alignment: .trailing, spacing: 4) {
                        StockBadge(entry: line.entry)
                        if let price = line.product.price {
                            Text(Fmt.money(price)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                }
                .opacity(line.entry.isIn ? 1 : 0.6)
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder private func productRows(_ group: StockProductGroup) -> some View {
        let p = group.product
        Button { open(p.url) } label: {
            HStack(spacing: 12) {
                StockPicture(url: p.image, name: p.name)
                VStack(alignment: .leading, spacing: 2) {
                    Text(p.name).font(.headline).foregroundStyle(.primary).multilineTextAlignment(.leading)
                    Text([group.chainName, p.price.map { Fmt.money($0) }, "\(group.places.count) store\(group.places.count == 1 ? "" : "s")"].compactMap { $0 }.joined(separator: " · "))
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
        }
        .buttonStyle(.plain)
        ForEach(group.places) { place in
            Button { openMaps(group.chainName, place.store) } label: {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(place.store.name).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                        StockSince(entry: place.entry, exact: group.exact)
                    }
                    Spacer(minLength: 8)
                    VStack(alignment: .trailing, spacing: 4) {
                        StockBadge(entry: place.entry)
                        if let d = Stock.miles(place.store.distance) {
                            Text(d).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .buttonStyle(.plain)
        }
    }

    private func subtitle(_ chain: String, _ s: StockDoc.Store) -> String {
        var parts = [chain]
        if let n = s.number, !n.isEmpty { parts.append("#\(n)") }
        if let city = s.city, !city.isEmpty { parts.append(s.state.map { "\(city), \($0)" } ?? city) }
        return parts.joined(separator: " · ")
    }

    private func open(_ link: String?) {
        if let link, let url = URL(string: link) { openURL(url) }
    }

    private func openMaps(_ chain: String, _ s: StockDoc.Store) {
        let place = [chain, s.address, s.city, s.state, s.zip].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        var parts = URLComponents(string: "https://maps.apple.com/")
        parts?.queryItems = [URLQueryItem(name: "q", value: place)]
        if let url = parts?.url { openURL(url) }
    }
}

/// "In stock", "Low stock", "3 on hand" or "Sold out", colored the same as on the website.
private struct StockBadge: View {
    let entry: StockDoc.Entry

    var body: some View {
        let color: Color = !entry.isIn ? .secondary : entry.low == true ? .orange : .up
        Text(Stock.label(entry))
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(color.opacity(entry.isIn ? 0.14 : 0.1), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .fixedSize()
    }
}

/// When it came in or sold out, and up to three changes before that.
private struct StockSince: View {
    let entry: StockDoc.Entry
    let exact: Bool

    var body: some View {
        let earlier = Array((entry.log ?? []).dropLast().suffix(3).reversed()).filter { $0.count >= 2 }
        VStack(alignment: .leading, spacing: 2) {
            Text("\(entry.isIn ? "In stock since" : "Sold out") \(Stock.when(entry.since))")
                .font(.caption).foregroundStyle(.secondary)
            ForEach(earlier, id: \.self) { item in
                HStack(spacing: 6) {
                    Circle().fill(item[1] == 0 ? Color.secondary.opacity(0.5) : Color.up).frame(width: 6, height: 6)
                    Text("\(Stock.when(item[0])) · \(Stock.logLabel(item[1], exact: exact))")
                }
                .font(.caption).foregroundStyle(.tertiary)
            }
        }
        .monospacedDigit()
    }
}

private struct StockPicture: View {
    let url: String?
    let name: String

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color(.tertiarySystemFill))
            if let url, let link = URL(string: url) {
                AsyncImage(url: link) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFit().background(Color.white)
                    } else {
                        initial
                    }
                }
            } else {
                initial
            }
        }
        .frame(width: 44, height: 44)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityHidden(true)
    }

    private var initial: some View {
        Text(String(name.prefix(1))).font(.headline).foregroundStyle(.tertiary)
    }
}
