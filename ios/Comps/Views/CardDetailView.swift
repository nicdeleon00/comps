import SwiftUI
import SwiftData
import Charts

@MainActor
struct CardDetailView: View {
    let cardID: String
    var holding: Holding? = nil
    var preview: CardSummary? = nil

    @Environment(\.openURL) private var openURL
    @State private var detail: CardDetail?
    @State private var direct: ScanCandidate?
    @State private var loading = true
    @State private var variant: String?
    @State private var series: Series = .raw
    @State private var selected: Date?
    @State private var editing = false
    @State private var adding = false

    enum Series: String, CaseIterable { case raw = "Raw", g9 = "PSA 9", psa10 = "PSA 10" }

    private var card: CardSummary? { detail?.card ?? direct?.card ?? preview }
    private var current: VariantDetail? {
        guard let d = detail else { return nil }
        return d.variants.first { $0.variant == (variant ?? holding?.variant) } ?? d.variants.first
    }

    private var points: [HistoryPoint] {
        guard let d = detail, let v = current else { return [] }
        return d.history[v.variant] ?? []
    }

    private var chartData: [(date: Date, value: Double)] {
        points.compactMap { p in
            let v: Double? = series == .raw ? p.raw : series == .g9 ? p.g9 : p.psa10
            return v.map { (date: p.date, value: $0) }
        }
    }

    private var headline: Double? {
        if let selected, let p = chartData.min(by: { abs($0.date.timeIntervalSince(selected)) < abs($1.date.timeIntervalSince(selected)) }) { return p.value }
        switch series {
        case .raw: return current?.price ?? direct?.variants.first(where: { $0.variant == variant })?.price ?? card?.price
        case .g9: return current?.grades?.g9
        case .psa10: return current?.grades?.psa10
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                if let card {
                    TiltingCard(card: card)
                        .frame(width: 230)
                        .padding(.top, 8)
                        .padding(.bottom, 22)
                    VStack(spacing: 4) {
                        Text([card.gameKind.label, card.year.map { String($0) }, card.rarity].compactMap { $0 }.joined(separator: " · "))
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(card.name).font(.largeTitle.bold()).multilineTextAlignment(.center)
                        Text(card.subtitle).font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal)
                } else if loading {
                    ProgressView().padding(.top, 120)
                }

                if let d = detail, d.variants.count > 1 {
                    Picker("Printing", selection: Binding(get: { current?.variant ?? "" }, set: { variant = $0; series = .raw })) {
                        ForEach(d.variants) { Text($0.label.isEmpty ? "Standard" : $0.label).tag($0.variant) }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal)
                    .padding(.top, 18)
                }

                if card != nil { priceBlock.padding(.horizontal).padding(.top, 22) }
                if chartData.count > 1 { chart.padding(.horizontal).padding(.top, 8) }
                if let h = holding { holdingCard(h).padding(.horizontal).padding(.top, 24) }
                if let v = current, let g = v.grades, !g.ladder.isEmpty { ladder(v, g).padding(.horizontal).padding(.top, 28) }
                if let g = current?.grading { gradingCard(g).padding(.horizontal).padding(.top, 28) }
                if let d = detail, !d.signals.isEmpty { signals(d.signals).padding(.horizontal).padding(.top, 28) }
                if let d = detail, !d.listings.isEmpty { listings(d.listings).padding(.horizontal).padding(.top, 28) }
                if let d = detail { links(d.links).padding(.horizontal).padding(.top, 28) }
                if detail == nil && !loading && APIClient.current == nil {
                    Text("Connect your Comps server in Settings for graded prices, history and live deals.")
                        .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        .padding(.horizontal, 30).padding(.top, 28)
                }
            }
            .padding(.bottom, 40)
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if holding != nil {
                    Button("Edit") { editing = true }
                } else if card != nil {
                    Button { adding = true } label: { Image(systemName: "plus.circle.fill").font(.title3) }
                        .accessibilityLabel("Add to collection")
                }
            }
        }
        .sheet(isPresented: $editing) { if let holding { HoldingEditor(holding: holding) } }
        .sheet(isPresented: $adding) {
            if let card {
                HoldingEditor(card: card, variants: variantOptions)
            }
        }
        .task(id: cardID) { await load() }
    }

    private var variantOptions: [VariantPrice] {
        if let d = detail { return d.variants.map { VariantPrice(variant: $0.variant, label: $0.label, price: $0.price, grades: $0.grades) } }
        return direct?.variants ?? []
    }

    private func load() async {
        loading = true
        defer { loading = false }
        if let api = APIClient.current, let d = (try? await api.card(cardID)) {
            withAnimation(.snappy) { detail = d }
            return
        }
        let id = cardID
        var c: ScanCandidate?
        if id.hasPrefix("pkm:") { c = try? await DirectProviders.pokemonCard(id: String(id.dropFirst(4))) }
        else if id.hasPrefix("mtg:") { c = try? await DirectProviders.scryfallCard(id: String(id.dropFirst(4))) }
        else if id.hasPrefix("ygo:") {
            let parts = id.split(separator: ":").map(String.init)
            if parts.count >= 2 { c = (try? await DirectProviders.yugioh(setCode: parts[1]))?.first { $0.card.id == id } }
        }
        withAnimation(.snappy) { direct = c }
    }

    // MARK: Sections

    private var priceBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(selected.map { $0.formatted(date: .abbreviated, time: .omitted) } ?? (series == .raw ? "Market value, raw" : "\(series.rawValue) value"))
                .font(.subheadline).foregroundStyle(.secondary)
            Text(Fmt.money(headline))
                .font(.system(size: 44, weight: .bold))
                .contentTransition(.numericText(value: headline ?? 0))
                .animation(.snappy, value: headline ?? 0)
            HStack(spacing: 8) {
                DeltaLabel(value: current?.change7d ?? card?.change7d, pill: true)
                Text("7 days").font(.footnote).foregroundStyle(.secondary)
                if let c30 = current?.change30d {
                    DeltaLabel(value: c30)
                    Text("30 days").font(.footnote).foregroundStyle(.secondary)
                }
            }
            if let v = current, v.grades?.g9 != nil || v.grades?.psa10 != nil {
                Picker("Series", selection: $series) {
                    Text("Raw").tag(Series.raw)
                    if v.grades?.g9 != nil { Text("PSA 9").tag(Series.g9) }
                    if v.grades?.psa10 != nil { Text("PSA 10").tag(Series.psa10) }
                }
                .pickerStyle(.segmented)
                .padding(.top, 10)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var chart: some View {
        let data = chartData
        let up = (data.last?.value ?? 0) >= (data.first?.value ?? 0)
        let tint = up ? Color.up : Color.down
        let lo = data.map(\.value).min() ?? 0
        let hi = data.map(\.value).max() ?? 1
        let pad = max((hi - lo) * 0.12, 0.5)
        return Chart {
            ForEach(data, id: \.date) { p in
                AreaMark(x: .value("Day", p.date), yStart: .value("Low", lo - pad), yEnd: .value("Price", p.value))
                    .foregroundStyle(LinearGradient(colors: [tint.opacity(0.2), tint.opacity(0)], startPoint: .top, endPoint: .bottom))
                LineMark(x: .value("Day", p.date), y: .value("Price", p.value))
                    .foregroundStyle(tint)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            if let selected { RuleMark(x: .value("Selected", selected)).foregroundStyle(.secondary.opacity(0.5)) }
        }
        .chartYScale(domain: (lo - pad)...(hi + pad))
        .chartYAxis {
            AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { v in
                AxisGridLine().foregroundStyle(.quaternary)
                AxisValueLabel { if let d = v.as(Double.self) { Text(Fmt.money(d)).font(.caption2) } }
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { _ in AxisValueLabel(format: .dateTime.month(.abbreviated).day()) }
        }
        .chartXSelection(value: $selected)
        .sensoryFeedback(.selection, trigger: selected)
        .frame(height: 200)
        .animation(.smooth, value: series)
    }

    private func holdingCard(_ h: Holding) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("In your collection").font(.title3.bold())
            HStack {
                GradeBadge(grader: h.grader, grade: h.grade, condition: h.condition)
                Text("\(h.quantity) × \(Fmt.money(h.unitValue))").font(.subheadline).foregroundStyle(.secondary)
                Spacer()
                Text(Fmt.money(h.totalValue)).font(.headline.monospacedDigit())
            }
            if let paid = h.totalCost, let gain = h.gain {
                HStack {
                    Text("Paid \(Fmt.money(paid))").font(.subheadline).foregroundStyle(.secondary)
                    Spacer()
                    Text(Fmt.signedMoney(gain)).font(.subheadline.weight(.semibold).monospacedDigit()).foregroundStyle(gain >= 0 ? Color.up : Color.down)
                }
            }
        }
        .padding(16)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func ladder(_ v: VariantDetail, _ g: Grades) -> some View {
        let rows: [(label: String, value: Double)] = (v.price.map { [(label: "Raw", value: $0)] } ?? []) + g.ladder
        let maxValue = rows.map(\.value).max() ?? 1
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Price by grade").font(.title3.bold())
                Spacer()
                if let vol = v.volume { Text("\(vol) sales / yr").font(.footnote).foregroundStyle(.secondary) }
            }
            ForEach(rows, id: \.label) { row in
                HStack(spacing: 10) {
                    Text(row.label).font(.subheadline).foregroundStyle(.secondary).frame(width: 74, alignment: .leading)
                    GeometryReader { geo in
                        RoundedRectangle(cornerRadius: 4, style: .continuous)
                            .fill(row.label == "Raw" ? Color.secondary.opacity(0.5) : Color.accentColor.opacity(0.85))
                            .frame(width: max(4, geo.size.width * row.value / maxValue))
                            .frame(maxHeight: .infinity, alignment: .center)
                    }
                    .frame(height: 12)
                    Text(Fmt.money(row.value)).font(.subheadline.weight(.semibold).monospacedDigit()).frame(width: 84, alignment: .trailing)
                }
            }
        }
    }

    private func gradingCard(_ g: GradingResult) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Should you grade it?").font(.title3.bold())
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Expected profit").font(.footnote).foregroundStyle(.secondary)
                    Text(Fmt.signedMoney(g.profit)).font(.title.bold().monospacedDigit()).foregroundStyle(g.profit >= 0 ? Color.up : Color.down)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("Return").font(.footnote).foregroundStyle(.secondary)
                    Text(Fmt.percent(g.roi)).font(.title3.weight(.semibold).monospacedDigit())
                }
            }
            Divider()
            HStack {
                stat("Break-even", g.breakEven.map { $0 <= 0.005 ? "No 10 needed" : "\(Int(($0 * 100).rounded()))% 10s" } ?? "Never")
                Spacer()
                stat("If it's a 10", Fmt.signedMoney(g.if10))
                Spacer()
                stat("10 vs raw", Fmt.multiple(g.multiple))
            }
            Text("Costs \(Fmt.money(g.cost)) all-in. Uses the grading fees and gem rates set on your server.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(16)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.subheadline.weight(.semibold).monospacedDigit())
        }
    }

    private func signals(_ list: [Deal]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Why it's flagged").font(.title3.bold())
            ForEach(list) { d in
                HStack(alignment: .top, spacing: 10) {
                    Text(d.kindLabel).font(.caption.weight(.semibold)).foregroundStyle(.tint)
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(d.reason).font(.subheadline).lineLimit(2)
                        Text("\(Fmt.money(d.price)) vs \(Fmt.money(d.value)) · score \(Int(d.score))").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    if let u = d.data.url, let url = URL(string: u) {
                        Button { openURL(url) } label: { Image(systemName: "arrow.up.right.square") }
                    }
                }
            }
        }
    }

    private func listings(_ list: [Listing]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Live listings").font(.title3.bold())
            ForEach(list.prefix(8)) { l in
                Button {
                    if let url = URL(string: l.url) { openURL(url) }
                } label: {
                    HStack {
                        Text(l.title).font(.subheadline).lineLimit(2).multilineTextAlignment(.leading).foregroundStyle(.primary)
                        Spacer()
                        GradeBadge(grader: l.grader, grade: l.grade)
                        Text(Fmt.money(l.total)).font(.subheadline.weight(.semibold).monospacedDigit()).foregroundStyle(.primary)
                    }
                }
                Divider()
            }
        }
    }

    private func links(_ l: DetailLinks) -> some View {
        VStack(spacing: 0) {
            ForEach([("eBay sold", l.ebaySold), ("eBay listings", l.ebay), ("Graded on eBay", l.ebayGraded), ("TCGplayer", l.tcgplayer), ("PriceCharting", l.pricecharting)], id: \.0) { item in
                if let s = item.1, let url = URL(string: s) {
                    Button { openURL(url) } label: {
                        HStack {
                            Text(item.0).foregroundStyle(.primary)
                            Spacer()
                            Image(systemName: "arrow.up.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 12)
                    }
                    Divider()
                }
            }
        }
    }
}

/// The card hero: drag to tilt it under the light.
struct TiltingCard: View {
    let card: CardSummary
    @State private var drag: CGSize = .zero

    var body: some View {
        CardImage(url: card.largeImageURL, name: card.name, game: card.gameKind, corner: 12)
            .overlay {
                LinearGradient(colors: [.white.opacity(0), .white.opacity(0.35), .white.opacity(0)],
                               startPoint: UnitPoint(x: 0.0 + drag.width / 300, y: 0.0 + drag.height / 300),
                               endPoint: UnitPoint(x: 1.0 + drag.width / 300, y: 1.0 + drag.height / 300))
                    .blendMode(.softLight)
                    .opacity(drag == .zero ? 0 : 1)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .allowsHitTesting(false)
            }
            .shadow(color: .black.opacity(0.22), radius: 18, y: 12)
            .rotation3DEffect(.degrees(Double(drag.width) / 9), axis: (x: 0, y: 1, z: 0), perspective: 0.6)
            .rotation3DEffect(.degrees(Double(-drag.height) / 9), axis: (x: 1, y: 0, z: 0), perspective: 0.6)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { v in
                        drag = CGSize(width: max(-120, min(120, v.translation.width)), height: max(-120, min(120, v.translation.height)))
                    }
                    .onEnded { _ in withAnimation(.spring(response: 0.55, dampingFraction: 0.55)) { drag = .zero } }
            )
            .animation(.interactiveSpring(response: 0.25, dampingFraction: 0.8), value: drag)
    }
}
