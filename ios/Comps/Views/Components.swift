import SwiftUI

/// Card art with a cached loader and a typeset placeholder.
struct CardImage: View {
    var url: URL?
    var name: String = ""
    var game: Game = .other
    var corner: CGFloat = 4

    @State private var image: UIImage?

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .transition(.opacity)
            } else {
                placeholder
            }
        }
        .aspectRatio(63.0 / 88.0, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous).strokeBorder(.primary.opacity(0.08), lineWidth: 0.5))
        .task(id: url) {
            guard let url else { image = nil; return }
            if let hit = ImageLoader.shared.cached(url) { image = hit; return }
            let loaded = await ImageLoader.shared.image(for: url)
            withAnimation(.easeOut(duration: 0.25)) { image = loaded }
        }
    }

    private var placeholder: some View {
        GeometryReader { geo in
            ZStack(alignment: .top) {
                LinearGradient(colors: [game.tint.opacity(0.22), game.tint.opacity(0.08)], startPoint: .top, endPoint: .bottom)
                Rectangle().fill(.background.opacity(0.9)).frame(height: geo.size.height * 0.12)
                Text(String(name.first ?? "?").uppercased())
                    .font(.system(size: geo.size.width * 0.38, weight: .bold, design: .default))
                    .foregroundStyle(game.tint.opacity(0.75))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

struct DeltaLabel: View {
    var value: Double?
    var pill = false

    var body: some View {
        if let value, value.isFinite {
            let up = value >= 0
            HStack(spacing: 2) {
                Image(systemName: up ? "arrowtriangle.up.fill" : "arrowtriangle.down.fill").font(.system(size: 8))
                Text(Fmt.percent(abs(value), signed: false))
            }
            .font(.footnote.weight(.semibold).monospacedDigit())
            .foregroundStyle(up ? Color.up : Color.down)
            .padding(.horizontal, pill ? 7 : 0)
            .padding(.vertical, pill ? 3 : 0)
            .background(pill ? (up ? Color.up : Color.down).opacity(0.13) : .clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        } else {
            Text("—").font(.footnote).foregroundStyle(.tertiary)
        }
    }
}

struct GradeBadge: View {
    var grader: String?
    var grade: String?
    var condition: String? = nil

    var body: some View {
        if let grader, let grade {
            let tint = Grader(rawValue: grader.uppercased())?.tint ?? .primary
            Text("\(grader.uppercased()) \(grade)")
                .font(.caption2.weight(.bold))
                .foregroundStyle(tint)
                .padding(.horizontal, 6).padding(.vertical, 2.5)
                .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
        } else {
            Text(condition.map { $0 == "NM" ? "Raw" : "Raw · \($0)" } ?? "Raw")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 6).padding(.vertical, 2.5)
                .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
        }
    }
}

/// A row used for cards across Search and Deals.
struct CardRow<Trailing: View>: View {
    var card: CardSummary
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 12) {
            CardImage(url: card.imageURL, name: card.name, game: card.gameKind)
                .frame(width: 42)
            VStack(alignment: .leading, spacing: 2) {
                Text(card.name).font(.body.weight(.semibold)).lineLimit(1)
                Text(card.subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            trailing()
        }
        .padding(.vertical, 2)
    }
}

extension View {
    /// Springy press feedback for custom buttons.
    func pressable() -> some View { buttonStyle(PressableStyle()) }
}

struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.6), value: configuration.isPressed)
    }
}
