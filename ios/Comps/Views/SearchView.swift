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
                                           description: Text(query.count < 2 ? "Pokémon, Magic, Yu-Gi-Oh!, and sports cards when your server has PriceCharting." : "Try fewer words, or the card number."))
                }
            }
            .navigationTitle("Search")
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Card, set or player")
            .navigationDestination(for: CardSummary.self) { c in CardDetailView(cardID: c.id, preview: c) }
            .task(id: query) {
                let q = query.trimmingCharacters(in: .whitespaces)
                guard q.count >= 2 else { results = []; return }
                try? await Task.sleep(for: .milliseconds(280))
                guard !Task.isCancelled else { return }
                searching = true
                defer { searching = false }
                let found: [CardSummary]
                if let api = APIClient.current, let r = (try? await api.search(q)) { found = r }
                else { found = await DirectProviders.search(q) }
                guard !Task.isCancelled else { return }
                withAnimation(.snappy) { results = found }
            }
            .sheet(item: $adding) { c in HoldingEditor(card: c, variants: []) }
        }
    }
}
