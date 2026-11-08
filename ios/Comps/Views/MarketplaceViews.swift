import SwiftUI

/// One Facebook Marketplace listing: the card, the seller's title, where, and a Buy button.
struct MarketRow: View {
    let listing: MarketListing
    var showCard = true
    @Environment(\.openURL) private var openURL

    var body: some View {
        HStack(spacing: 12) {
            if showCard {
                CardImage(url: listing.card?.imageURL, name: listing.card?.name ?? listing.title, game: .pokemon)
                    .frame(width: 44)
                    .cardShadow()
            }
            VStack(alignment: .leading, spacing: 3) {
                if showCard {
                    HStack(spacing: 6) {
                        Text(listing.card?.name ?? "Card").font(.body.weight(.semibold)).lineLimit(1)
                        if let g = listing.grade, let space = g.firstIndex(of: " ") {
                            GradeBadge(grader: String(g[..<space]), grade: String(g[g.index(after: space)...]))
                        }
                    }
                }
                Text("“\(listing.title)”").font(showCard ? .footnote : .subheadline).foregroundStyle(showCard ? .secondary : .primary).lineLimit(1)
                Text([listing.location, "seen \(listing.seenAt.formatted(.relative(presentation: .named)))", listing.confident ? nil : "check it’s this card"]
                    .compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.tertiary).lineLimit(1)
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 4) {
                Text(Fmt.money(listing.price)).font(.body.weight(.bold).monospacedDigit())
                if let d = listing.discount, abs(d) >= 0.05 {
                    Text("\(Int((abs(d) * 100).rounded()))% \(d > 0 ? "under" : "over")")
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .foregroundStyle(listing.isDeal ? Color.up : d < -0.15 ? Color.down : .secondary)
                } else if let v = listing.value {
                    Text("worth \(Fmt.money(v))").font(.caption).foregroundStyle(.secondary)
                }
                Button { openURL(listing.url) } label: {
                    Text("Buy")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12).padding(.vertical, 5)
                        .background(Color.accentColor, in: Capsule())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Buy on Facebook Marketplace")
            }
        }
        .padding(.vertical, 3)
    }
}

/// Card page section: copies of this card for sale on Facebook Marketplace.
@MainActor
struct CardMarketplaceSection: View {
    let cardID: String
    @State private var listings: [MarketListing] = []

    var body: some View {
        Group {
            if !listings.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("For sale on Facebook Marketplace").font(.title3.weight(.bold))
                        Spacer()
                        Text("\(listings.count)").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                    }
                    VStack(spacing: 0) {
                        ForEach(listings) { l in
                            MarketRow(listing: l, showCard: false)
                            if l.id != listings.last?.id { Divider() }
                        }
                    }
                    .panel(padding: 12)
                }
            }
        }
        .task(id: cardID) {
            let found = (try? await Marketplace.listings(cardID: cardID)) ?? []
            withAnimation(.snappy) { listings = found.filter { $0.status != "sold" } }
        }
    }
}
