import SwiftUI
import SwiftData

/// One "Add to Collection": the cards added together (a scan session, a binder page, or one card).
struct AddSession: Identifiable {
    let id: UUID
    let start: Date
    /// In the order they were added, which for a scan is the order they were scanned.
    let holdings: [Holding]

    var cards: Int { holdings.reduce(0) { $0 + $1.quantity } }
    var value: Double { holdings.reduce(0) { $0 + ($1.totalValue ?? 0) } }
}

enum AddHistory {
    /// Cards added within this many seconds of each other were added together: one "Add to
    /// Collection" saves all of its cards in a split second. The website uses the same rule
    /// (web/src/lib/history.ts), and the add time syncs with each card, so both agree.
    static let gap: TimeInterval = 5

    /// Newest first.
    static func sessions(_ holdings: [Holding]) -> [AddSession] {
        var out: [AddSession] = []
        var run: [Holding] = []
        func close() {
            if let first = run.first { out.append(AddSession(id: first.id, start: first.createdAt, holdings: run)) }
            run = []
        }
        for h in holdings.sorted(by: { $0.createdAt < $1.createdAt }) {
            if let last = run.last, h.createdAt.timeIntervalSince(last.createdAt) > gap { close() }
            run.append(h)
        }
        close()
        return out.reversed()
    }

    struct Day: Identifiable {
        let day: Date
        var sessions: [AddSession]
        var id: Date { day }
    }

    /// Sessions grouped by the day they were added, newest first.
    static func days(_ holdings: [Holding]) -> [Day] {
        var out: [Day] = []
        for s in sessions(holdings) {
            let day = Calendar.current.startOfDay(for: s.start)
            if let i = out.indices.last, out[i].day == day { out[i].sessions.append(s) } else { out.append(Day(day: day, sessions: [s])) }
        }
        return out
    }

    static func dayTitle(_ day: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(day) { return "Today" }
        if cal.isDateInYesterday(day) { return "Yesterday" }
        let sameYear = cal.component(.year, from: day) == cal.component(.year, from: .now)
        return sameYear ? day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
                        : day.formatted(.dateTime.month(.abbreviated).day().year())
    }
}

/// Everything added to the collection, one row per "Add to Collection", newest first.
/// Open one to check what that scan added and fix anything it got wrong.
@MainActor
struct HistoryView: View {
    @Query(filter: #Predicate<Holding> { $0.isTombstoned == false }, sort: \Holding.createdAt, order: .reverse) private var holdings: [Holding]
    @State private var openFirst = Screenshots.flag("-session")

    var body: some View {
        let groups = AddHistory.days(holdings)
        List {
            ForEach(groups) { group in
                Section {
                    ForEach(group.sessions) { s in
                        NavigationLink { HistorySessionView(session: s) } label: { SessionRow(session: s) }
                    }
                } header: {
                    HStack {
                        Text(AddHistory.dayTitle(group.day))
                        Spacer()
                        let n = group.sessions.reduce(0) { $0 + $1.cards }
                        Text("\(n) card\(n == 1 ? "" : "s")").monospacedDigit()
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("History")
        .overlay {
            if holdings.isEmpty {
                ContentUnavailableView("Nothing added yet", systemImage: "clock.arrow.circlepath",
                                       description: Text("Every time you add cards they show up here, so you can check a scan and fix it later."))
            }
        }
        .navigationDestination(isPresented: $openFirst) {
            if let s = groups.first?.sessions.first { HistorySessionView(session: s) }
        }
    }
}

private struct SessionRow: View {
    let session: AddSession

    private var title: String {
        session.holdings.count == 1 && session.cards == 1 ? session.holdings[0].name : "\(session.cards) cards"
    }

    private var detail: String {
        let time = session.start.formatted(date: .omitted, time: .shortened)
        if session.holdings.count == 1 { return [time, session.holdings[0].subtitle].filter { !$0.isEmpty }.joined(separator: " · ") }
        let names = session.holdings.prefix(2).map(\.name).joined(separator: ", ")
        let more = session.holdings.count - 2
        return "\(time) · \(names)\(more > 0 ? " +\(more)" : "")"
    }

    var body: some View {
        HStack(spacing: 14) {
            ThumbStack(holdings: Array(session.holdings.prefix(4)))
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.body.weight(.semibold)).lineLimit(1)
                Text(detail).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(Fmt.money(session.value)).font(.body.weight(.semibold).monospacedDigit())
        }
        .padding(.vertical, 4)
    }
}

/// A few cards fanned out: the first of a session at the front.
private struct ThumbStack: View {
    let holdings: [Holding]

    var body: some View {
        ZStack(alignment: .leading) {
            ForEach(Array(holdings.enumerated().reversed()), id: \.element.id) { i, h in
                CardImage(url: URL(string: h.imageURL ?? ""), name: h.name, game: h.gameKind, corner: 3)
                    .frame(width: 34)
                    .cardShadow()
                    .offset(x: CGFloat(i) * 12)
            }
        }
        .frame(width: 34 + 3 * 12, alignment: .leading)
    }
}

/// The cards one "Add to Collection" added, in the order they were scanned. Tap one to fix
/// it (the card itself, printing, grade, quantity); swipe to remove; or remove the lot.
@MainActor
struct HistorySessionView: View {
    let ids: Set<UUID>
    let start: Date
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Query(filter: #Predicate<Holding> { $0.isTombstoned == false }, sort: \Holding.createdAt) private var all: [Holding]
    @State private var editing: Holding?
    @State private var query = ""
    @State private var confirmRemoveAll = false

    init(session: AddSession) {
        ids = Set(session.holdings.map(\.id))
        start = session.start
    }

    private var cards: [Holding] { all.filter { ids.contains($0.id) } }

    private var shown: [Holding] {
        let words = query.lowercased().split(separator: " ").map(String.init)
        guard !words.isEmpty else { return cards }
        return cards.filter { h in
            let number = (h.number ?? "").lowercased()
            let hay = [h.name, h.setName ?? "", number, String(number.drop { $0 == "0" }), h.variant.map(VariantName.label) ?? ""]
                .joined(separator: " ").lowercased()
            return words.allSatisfy { hay.contains($0) }
        }
    }

    var body: some View {
        let list = cards
        let count = list.reduce(0) { $0 + $1.quantity }
        let value = list.reduce(0) { $0 + ($1.totalValue ?? 0) }
        List {
            // Fixed sections: the list's shape never changes while a card is being removed.
            Section {
                HStack(spacing: 10) {
                    StatTile(title: "Cards", value: "\(count)")
                    StatTile(title: "Value", value: Fmt.money(value))
                    StatTile(title: "Added", value: start.formatted(date: .omitted, time: .shortened),
                             note: AddHistory.dayTitle(Calendar.current.startOfDay(for: start)))
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
            Section {
                ForEach(shown) { h in
                    Button { editing = h } label: { HoldingRow(holding: h) }
                        .tint(.primary)
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { Portfolio.remove(h, context: context) } label: { Label("Remove", systemImage: "trash") }
                            Button { editing = h } label: { Label("Fix", systemImage: "wand.and.stars") }.tint(.indigo)
                        }
                        .contextMenu {
                            Button { editing = h } label: { Label("Fix", systemImage: "wand.and.stars") }
                            Button(role: .destructive) { Portfolio.remove(h, context: context) } label: { Label("Remove", systemImage: "trash") }
                        }
                }
            } header: {
                Text(list.isEmpty ? "Everything from this scan was removed." : "Tap a card to fix it: the card, printing, grade or quantity. Swipe to remove it.")
                    .textCase(nil)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(count == 1 ? "1 card" : "\(count) cards")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Find a card in this scan")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button(role: .destructive) { confirmRemoveAll = true } label: {
                        Label("Remove all \(count) from Collection", systemImage: "trash")
                    }
                } label: { Image(systemName: "ellipsis.circle") }
                .disabled(list.isEmpty)
                .accessibilityLabel("More")
            }
        }
        .confirmationDialog("Remove all \(count) cards from this scan?", isPresented: $confirmRemoveAll, titleVisibility: .visible) {
            Button("Remove all", role: .destructive) {
                Portfolio.remove(list, context: context)
                dismiss()
            }
        } message: {
            Text("They come off your collection here and on the website.")
        }
        .sheet(item: $editing) { h in HoldingEditor(holding: h) }
    }
}
