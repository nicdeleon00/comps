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

    /// A rounded card on the grouped background, like the website's panels.
    func panel(padding: CGFloat = 14, radius: CGFloat = 18) -> some View {
        self
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .shadow(color: .black.opacity(0.06), radius: 10, y: 3)
    }

    /// The soft drop shadow card art gets in grids and headers.
    func cardShadow() -> some View { shadow(color: .black.opacity(0.22), radius: 6, y: 3) }
}

/// A small number with a label, used in headers (Collection, Master Sets).
struct StatTile: View {
    let title: String
    let value: String
    var note: String? = nil
    var progress: Double? = nil
    var tint: Color = .primary

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            Text(value).font(.title3.weight(.bold)).monospacedDigit().foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.6)
                .contentTransition(.numericText())
            if let progress {
                ProgressView(value: min(1, max(0, progress))).tint(progress >= 1 ? Color.up : Color.accentColor)
            }
            if let note { Text(note).font(.caption2).foregroundStyle(.secondary).lineLimit(2) }
        }
        .panel(padding: 12, radius: 14)
    }
}

/// A ring that fills as a set gets completed.
struct ProgressRing: View {
    let value: Double
    var lineWidth: CGFloat = 5

    var body: some View {
        ZStack {
            Circle().stroke(Color(.tertiarySystemFill), lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: min(1, max(0, value)))
                .stroke(value >= 1 ? Color.up : Color.accentColor, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.smooth(duration: 0.6), value: value)
        }
    }
}

/// A row of pill buttons that scrolls sideways (filters such as deal types).
struct ChipBar<Value: Hashable>: View {
    let options: [(Value, String)]
    @Binding var selection: Value

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(options, id: \.1) { option in
                    let on = option.0 == selection
                    Button {
                        withAnimation(.snappy) { selection = option.0 }
                    } label: {
                        Text(option.1)
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 13).padding(.vertical, 7)
                            .foregroundStyle(on ? Color.white : .primary)
                            .background(on ? Color.accentColor : Color(.tertiarySystemFill), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .sensoryFeedback(.selection, trigger: on)
                }
            }
            .padding(.horizontal, 1)
        }
    }
}

struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.6), value: configuration.isPressed)
    }
}

/// A red band across a card's picture that reads CHINESE (a Chinese card has no market price).
struct LanguageBanner: ViewModifier {
    var on: Bool

    func body(content: Content) -> some View {
        content.overlay {
            if on {
                GeometryReader { geo in
                    Text("CHINESE")
                        .font(.system(size: max(6, geo.size.width * 0.15), weight: .heavy))
                        .tracking(geo.size.width * 0.008)
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .frame(width: geo.size.width * 1.4, height: max(8, geo.size.width * 0.22))
                        .background(Color(red: 0.84, green: 0.15, blue: 0.24))
                        .shadow(color: .black.opacity(0.3), radius: 1.5, y: 1)
                        .rotationEffect(.degrees(-28))
                        .position(x: geo.size.width / 2, y: geo.size.height / 2)
                }
                .clipped()
                .allowsHitTesting(false)
                .accessibilityLabel("Chinese card")
            }
        }
    }
}

extension View {
    /// Marks a card's picture as a Chinese card.
    func chineseBanner(_ on: Bool) -> some View { modifier(LanguageBanner(on: on)) }
}

/// The small CHINESE label next to a card's name.
struct ChineseLabel: View {
    var body: some View {
        Text("CHINESE")
            .font(.caption2.weight(.heavy))
            .foregroundStyle(.white)
            .padding(.horizontal, 5).padding(.vertical, 1.5)
            .background(Color(red: 0.84, green: 0.15, blue: 0.24), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
    }
}
