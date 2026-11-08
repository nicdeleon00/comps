import SwiftUI
import SwiftData

/// Review everything from a continuous scanning session before it hits the collection.
@MainActor
struct ScanReviewView: View {
    let model: ScannerModel
    var onDone: (Int) -> Void
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @State private var confirmClear = false

    private var addable: [ScanItem] { model.items.filter { $0.choice != nil } }

    var body: some View {
        NavigationStack {
            // One section that never comes or goes: changing the list's shape while a row is being
            // swiped away is what crashed it.
            List {
                Section {
                    ForEach(Array(model.items.enumerated()), id: \.element.id) { i, item in
                        NavigationLink {
                            ScanPager(items: model.items, start: i)
                        } label: {
                            ReviewRow(item: item)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button(role: .destructive) { model.remove(item) } label: { Label("Remove", systemImage: "trash") }
                        }
                        .contextMenu {
                            Button(role: .destructive) { model.remove(item, animated: true) } label: { Label("Remove", systemImage: "trash") }
                        }
                    }
                } header: {
                    Label(hint, systemImage: model.items.contains(where: { $0.status == .review }) ? "questionmark.circle.fill" : "hand.draw")
                        .font(.footnote)
                        .textCase(nil)
                }
            }
            .navigationTitle("\(model.items.count) scanned")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Keep scanning") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button(role: .destructive) { confirmClear = true } label: { Label("Remove all", systemImage: "trash") }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .disabled(model.items.isEmpty)
                    .accessibilityLabel("More")
                }
            }
            .confirmationDialog("Remove all \(model.items.count) scanned cards?", isPresented: $confirmClear, titleVisibility: .visible) {
                Button("Remove all", role: .destructive) { model.removeAll() }
            } message: {
                Text("They won’t be added to your collection.")
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    let n = model.commit(addable, context: context)
                    onDone(n)
                } label: {
                    HStack {
                        Text("Add \(addable.reduce(0) { $0 + $1.quantity }) to Collection")
                        Spacer()
                        Text(Fmt.money(model.total)).monospacedDigit()
                    }
                    .font(.headline)
                    .padding(.horizontal, 20)
                    .frame(maxWidth: .infinity, minHeight: 52)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.roundedRectangle(radius: 14))
                .disabled(addable.isEmpty)
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
                .background(.bar)
            }
        }
    }

    private var hint: String {
        model.items.contains(where: { $0.status == .review })
            ? "Cards marked ? had a close second match. Tap one to check it. Swipe left to remove a card."
            : "Tap a card to fix it. Swipe left to remove it. Saved as you go, so nothing’s lost if the app closes."
    }
}

private struct ReviewRow: View {
    let item: ScanItem

    var body: some View {
        HStack(spacing: 12) {
            Image(uiImage: item.photo)
                .resizable().aspectRatio(contentMode: .fill)
                .frame(width: 38, height: 53)
                .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
            if let c = item.choice {
                CardImage(url: c.card.imageURL, name: c.card.name, game: c.card.gameKind).frame(width: 38)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(c.card.name).font(.body.weight(.semibold)).lineLimit(1)
                        if item.status == .review {
                            Image(systemName: "questionmark.circle.fill").foregroundStyle(.orange)
                        }
                    }
                    Text([item.pocket, c.card.subtitle].compactMap { $0 }.joined(separator: " · ")).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                    GradeBadge(grader: item.grader, grade: item.grade, condition: item.condition)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(Fmt.money(item.unitValue)).font(.body.weight(.semibold).monospacedDigit())
                    if item.quantity > 1 { Text("× \(item.quantity)").font(.caption).foregroundStyle(.secondary) }
                }
            } else if item.status == .matching {
                ProgressView()
                Text("Matching…").foregroundStyle(.secondary)
                Spacer()
            } else {
                VStack(alignment: .leading) {
                    Text("No match").font(.body.weight(.semibold))
                    Text("Tap to search by name").font(.footnote).foregroundStyle(.secondary)
                }
                Spacer()
            }
        }
    }
}

/// Swipe through scanned cards, fixing each one.
@MainActor
struct ScanPager: View {
    let items: [ScanItem]
    @State private var index: Int

    init(items: [ScanItem], start: Int) {
        self.items = items
        _index = State(initialValue: min(max(0, start), max(0, items.count - 1)))
    }

    var body: some View {
        TabView(selection: $index) {
            ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                ScanItemEditor(item: item, embedded: true).tag(i)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .background(Color(.systemGroupedBackground))
        .navigationTitle(items.isEmpty ? "" : "\(index + 1) of \(items.count)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { withAnimation(.snappy) { index = max(0, index - 1) } } label: { Image(systemName: "chevron.left") }
                    .disabled(index == 0)
                    .accessibilityLabel("Previous card")
                Button { withAnimation(.snappy) { index = min(items.count - 1, index + 1) } } label: { Image(systemName: "chevron.right") }
                    .disabled(index >= items.count - 1)
                    .accessibilityLabel("Next card")
            }
        }
        .sensoryFeedback(.selection, trigger: index)
    }
}

/// Fix a scan: choose the right card/printing, grade, condition and quantity.
/// The scan and the current match stay pinned at the top while the list scrolls.
@MainActor
struct ScanItemEditor: View {
    @Bindable var item: ScanItem
    var embedded = false
    @State private var query = ""
    @State private var setFilter: SetOption?
    @State private var results: [ScanCandidate]?
    @State private var searching = false
    @State private var pickingSet = false
    @State private var quickSets: [SetOption] = []
    @State private var searchTask: Task<Void, Never>?
    @FocusState private var typing: Bool

    private var shown: [ScanCandidate] { results ?? item.candidates }

    var body: some View {
        VStack(spacing: 0) {
            header
            List {
                Section {
                    if shown.isEmpty && !searching {
                        Text(results == nil ? "No match yet — search by name or number above." : "No cards found.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(shown) { c in
                        Button { pick(c) } label: { CandidateRow(candidate: c, selected: c.id == item.choice?.id) }
                            .tint(.primary)
                    }
                } header: {
                    Text(listTitle)
                }

                if let c = item.choice, c.variants.count > 1 {
                    Section("Printing") {
                        Picker("Printing", selection: Binding(get: { item.variant ?? c.variants[0].variant }, set: { item.variant = $0 })) {
                            ForEach(c.variants, id: \.variant) { v in
                                Text("\(v.label.isEmpty ? "Standard" : v.label) · \(Fmt.money(v.price))").tag(v.variant)
                            }
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                    }
                }

                Section("Condition") {
                    Toggle("Graded", isOn: Binding(get: { item.grader != nil }, set: { on in
                        item.grader = on ? (item.grader ?? "PSA") : nil
                        item.grade = on ? (item.grade ?? "10") : nil
                    }))
                    if item.grader != nil {
                        Picker("Grader", selection: Binding(get: { item.grader ?? "PSA" }, set: { item.grader = $0 })) {
                            ForEach(Grader.allCases) { Text($0.rawValue).tag($0.rawValue) }
                        }
                        Picker("Grade", selection: Binding(get: { item.grade ?? "10" }, set: { item.grade = $0 })) {
                            ForEach(gradeOptions, id: \.self) { Text($0).tag($0) }
                        }
                    } else {
                        Picker("Condition", selection: $item.condition) {
                            ForEach(CardCondition.allCases) { Text($0.rawValue).tag($0.rawValue) }
                        }
                        .pickerStyle(.segmented)
                    }
                    Stepper("Quantity: \(item.quantity)", value: $item.quantity, in: 1...99)
                }

                Section {
                    HStack {
                        Text("Value")
                        Spacer()
                        Text(Fmt.money(item.unitValue.map { $0 * Double(item.quantity) })).monospacedDigit().foregroundStyle(.secondary)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollDismissesKeyboard(.immediately)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(embedded ? "" : (item.choice?.card.name ?? "Fix match"))
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $pickingSet) { SetPickerView(selection: $setFilter) }
        .onChange(of: query) { runSearch() }
        .onChange(of: setFilter) { runSearch() }
        .task { await loadQuickSets() }
    }

    // MARK: Pinned header

    private var header: some View {
        VStack(spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                compare(title: item.pocket.map { "Your scan · \($0)" } ?? "Your scan") {
                    ScanPhotoView(item: item)
                }
                compare(title: item.choice.map { "\($0.card.subtitle) · \(Fmt.money(item.unitValue))" } ?? "No match") {
                    if let c = item.choice {
                        CardImage(url: c.card.largeImageURL, name: c.card.name, game: c.card.gameKind, corner: 8)
                            .id(c.id)
                            .transition(.opacity)
                    } else {
                        RoundedRectangle(cornerRadius: 8, style: .continuous).fill(.quaternary)
                    }
                }
            }
            .frame(height: typing ? 118 : 196)
            .frame(maxWidth: .infinity)

            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField(setFilter.map { "Search \($0.name)" } ?? "Name or number", text: $query)
                    .focused($typing)
                    .submitLabel(.search)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                if searching {
                    ProgressView().controlSize(.small)
                } else if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 11, style: .continuous))

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    chip("All sets", on: setFilter == nil) { setFilter = nil }
                    if let s = setFilter, !quickSets.contains(s) {
                        chip(s.name, on: true) { setFilter = nil }
                    }
                    ForEach(quickSets) { s in
                        chip(s.name, on: setFilter == s) { setFilter = setFilter == s ? nil : s }
                    }
                    chip("Choose set…", on: false, icon: "line.3.horizontal.decrease") { pickingSet = true }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 10)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
        .animation(.snappy, value: typing)
    }

    private func compare<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 5) {
            content()
                .aspectRatio(63.0 / 88.0, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .shadow(color: .black.opacity(0.15), radius: 5, y: 2)
                .frame(maxHeight: .infinity)
            Text(title).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(maxWidth: .infinity)
    }

    private func chip(_ label: String, on: Bool, icon: String? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if let icon { Image(systemName: icon).font(.caption2.weight(.bold)) }
                Text(label).lineLimit(1)
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(on ? Color.white : Color.primary)
            .padding(.horizontal, 12)
            .frame(height: 30)
            .background(on ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.fill.tertiary), in: Capsule())
        }
        .buttonStyle(.plain)
    }

    private var listTitle: String {
        let q = query.trimmingCharacters(in: .whitespaces)
        if let s = setFilter { return q.isEmpty ? "\(s.name) · \(shown.count) cards" : "Results in \(s.name)" }
        if !q.isEmpty { return "Results" }
        return item.status == .review ? "Close call — tap the right card" : "Best matches"
    }

    // MARK: Actions

    private func pick(_ c: ScanCandidate) {
        withAnimation(.snappy) {
            if let i = item.candidates.firstIndex(where: { $0.id == c.id }) {
                item.choose(i)
            } else {
                item.candidates.insert(c, at: 0)
                item.choose(0)
            }
        }
        typing = false
    }

    private func runSearch() {
        searchTask?.cancel()
        let q = query.trimmingCharacters(in: .whitespaces)
        let set = setFilter?.id
        guard q.count >= 2 || (q.isEmpty && set != nil) || (set != nil && !q.isEmpty) else {
            results = nil
            searching = false
            return
        }
        searching = true
        searchTask = Task {
            if !q.isEmpty { try? await Task.sleep(for: .milliseconds(220)) }
            guard !Task.isCancelled else { return }
            await Catalog.shared.ensureLoaded()
            let found = await Catalog.shared.lookup(q, setId: set, limit: q.isEmpty ? 500 : 80)
            guard !Task.isCancelled else { return }
            withAnimation(.snappy) {
                results = found
                searching = false
            }
        }
    }

    /// Chips for the sets the likely matches come from.
    private func loadQuickSets() async {
        await Catalog.shared.ensureLoaded()
        let all = await Catalog.shared.setOptions()
        var seen = Set<String>()
        var picks: [SetOption] = []
        for c in item.candidates {
            guard let name = c.card.setName, seen.insert(name).inserted, let s = all.first(where: { $0.name == name }) else { continue }
            picks.append(s)
            if picks.count == 5 { break }
        }
        quickSets = picks
    }
}

/// A candidate in the fix list: big enough art to tell printings apart at a glance.
private struct CandidateRow: View {
    let candidate: ScanCandidate
    let selected: Bool

    var body: some View {
        HStack(spacing: 12) {
            CardImage(url: candidate.card.imageURL, name: candidate.card.name, game: candidate.card.gameKind, corner: 4)
                .frame(width: 50)
            VStack(alignment: .leading, spacing: 2) {
                Text(candidate.card.name).font(.body.weight(.semibold)).lineLimit(2)
                Text(candidate.card.subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                if let r = candidate.card.rarity { Text(r).font(.caption).foregroundStyle(.tertiary).lineLimit(1) }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 4) {
                Text(Fmt.money(candidate.card.price)).font(.subheadline.weight(.semibold).monospacedDigit())
                if selected {
                    Image(systemName: "checkmark.circle.fill").font(.body).foregroundStyle(Color.accentColor)
                }
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}

/// Single-scan result: confirm and add.
@MainActor
struct SingleResultSheet: View {
    @Bindable var item: ScanItem
    var onAdd: () -> Void

    var body: some View {
        NavigationStack {
            ScanItemEditor(item: item)
                .safeAreaInset(edge: .bottom) {
                    Button(action: onAdd) {
                        Text(item.choice == nil ? "No match" : "Add to Collection · \(Fmt.money(item.unitValue.map { $0 * Double(item.quantity) }))")
                            .font(.headline)
                            .frame(maxWidth: .infinity, minHeight: 52)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.roundedRectangle(radius: 14))
                    .disabled(item.choice == nil)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                }
        }
    }
}

/// The scan in the review screen: the small copy at once, then the sharper one from disk.
private struct ScanPhotoView: View {
    let item: ScanItem
    @State private var large: UIImage?

    var body: some View {
        Image(uiImage: large ?? item.photo)
            .resizable()
            .aspectRatio(63.0 / 88.0, contentMode: .fill)
            .task(id: item.id) { large = await item.largePhoto() }
    }
}
