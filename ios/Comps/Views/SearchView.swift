import SwiftUI

@MainActor
struct SearchView: View {
    @State private var query = ""
    @State private var results: [CardSummary] = []
    @State private var searching = false
    @State private var adding: CardSummary?

    var body: some View {
        NavigationStack {
            List {
                ForEach(results) { c in
                    NavigationLink(value: c) {
                        CardRow(card: c) {
                            VStack(alignment: .trailing, spacing: 2) {
                                Text(Fmt.money(c.price)).font(.subheadline.weight(.semibold).monospacedDigit())
                                Text(c.gameKind.label).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .swipeActions(edge: .trailing) {
                        Button { adding = c } label: { Label("Add", systemImage: "plus") }.tint(.accentColor)
                    }
                }
            }
            .listStyle(.plain)
            .overlay {
                if searching && results.isEmpty {
                    ProgressView()
                } else if results.isEmpty {
                    ContentUnavailableView(query.count < 2 ? "Search any card" : "No results",
                                           systemImage: "magnifyingglass",
                                           description: Text(query.count < 2 ? "Every English Pokémon card. Try “Charizard 4/102” or “Umbreon VMAX”." : "Try fewer words, or the card number."))
                }
            }
            .navigationTitle("Search")
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Card, set or number")
            .navigationDestination(for: CardSummary.self) { c in CardDetailView(cardID: c.id, preview: c) }
            .task(id: query) {
                let q = query.trimmingCharacters(in: .whitespaces)
                guard q.count >= 2 else { results = []; return }
                try? await Task.sleep(for: .milliseconds(280))
                guard !Task.isCancelled else { return }
                searching = true
                defer { searching = false }
                await Catalog.shared.ensureLoaded()
                let found = await Catalog.shared.search(q)
                guard !Task.isCancelled else { return }
                withAnimation(.snappy) { results = found }
            }
            .sheet(item: $adding) { c in AddFromSearch(card: c) }
        }
    }
}

/// Loads the card's printings from the catalog before showing the editor.
@MainActor
struct AddFromSearch: View {
    let card: CardSummary
    @State private var variants: [VariantPrice]?

    var body: some View {
        Group {
            if let variants { HoldingEditor(card: card, variants: variants) } else { ProgressView() }
        }
        .task { variants = await Catalog.shared.variants(id: card.id) }
    }
}
