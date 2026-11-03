import SwiftUI
import SwiftData

private let scanYellow = Color(red: 1, green: 0.84, blue: 0.04)

/// Binder mode's live view: the page guide with its pockets, and every card the camera currently sees.
struct BinderOverlay: View {
    var layout: BinderLayout
    var quads: [Quad]
    var frameSize: CGSize

    var body: some View {
        GeometryReader { geo in
            let mapper = FrameMapper(frame: frameSize, view: geo.size, fill: false)
            let guide = mapper.rect(layout.guide(frame: frameSize))
            let pw = guide.width / CGFloat(layout.columns), ph = guide.height / CGFloat(layout.rows)
            ZStack {
                ForEach(0..<layout.count, id: \.self) { i in
                    let r = i / layout.columns, c = i % layout.columns
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(.white.opacity(0.35), style: StrokeStyle(lineWidth: 1.5, dash: [6, 5]))
                        .frame(width: pw - 8, height: ph - 8)
                        .position(x: guide.minX + (CGFloat(c) + 0.5) * pw, y: guide.minY + (CGFloat(r) + 0.5) * ph)
                }
                CornerBrackets()
                    .stroke(.white.opacity(0.85), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .frame(width: guide.width, height: guide.height)
                    .position(x: guide.midX, y: guide.midY)
                ForEach(Array(quads.enumerated()), id: \.offset) { _, q in
                    let pts = q.points.map(mapper.point)
                    Path { p in
                        p.move(to: pts[0])
                        for pt in pts.dropFirst() { p.addLine(to: pt) }
                        p.closeSubpath()
                    }
                    .stroke(scanYellow, style: StrokeStyle(lineWidth: 2.5, lineJoin: .round))
                }
            }
            .animation(.easeOut(duration: 0.15), value: quads.count)
        }
        .allowsHitTesting(false)
    }
}

/// The page that was just read: the photo with each pocket's match, and the list to fix or add them.
@MainActor
struct BinderPageView: View {
    let page: BinderPage
    let model: ScannerModel
    var onAdded: (Int) -> Void
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    private var addable: [ScanItem] { page.items.filter { $0.choice != nil } }
    private var toCheck: Int { page.items.filter { $0.status == .review || $0.status == .failed }.count }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    PagePhoto(page: page)
                        .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8))
                }
                if page.reading && page.pockets.isEmpty {
                    Section {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Finding cards on the page…").foregroundStyle(.secondary)
                        }
                    }
                } else if !page.reading && page.pockets.isEmpty {
                    Section {
                        Label("No cards found. Fill the frame with the page, avoid glare, and try again.", systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                if !page.pockets.isEmpty {
                    Section {
                        ForEach(Array(page.pockets.enumerated()), id: \.element.id) { i, pocket in
                            NavigationLink {
                                ScanPager(items: page.items, start: i)
                            } label: {
                                PocketRow(item: pocket.item)
                            }
                        }
                    } header: {
                        Text(page.reading ? "Matching…" : toCheck > 0 ? "\(toCheck) to check" : "All matched")
                    }
                }
            }
            .navigationTitle("\(page.pockets.count) card\(page.pockets.count == 1 ? "" : "s")")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Next page") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    let n = model.commit(addable, context: context)
                    onAdded(n)
                } label: {
                    HStack {
                        Text("Add \(addable.reduce(0) { $0 + $1.quantity }) to Collection")
                        Spacer()
                        Text(Fmt.money(page.total)).monospacedDigit().contentTransition(.numericText(value: page.total))
                    }
                    .font(.headline)
                    .padding(.horizontal, 20)
                    .frame(maxWidth: .infinity, minHeight: 52)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.roundedRectangle(radius: 14))
                .disabled(addable.isEmpty || page.reading)
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
                .background(.bar)
            }
        }
    }
}

/// The page photo with a status badge on each pocket.
private struct PagePhoto: View {
    let page: BinderPage

    var body: some View {
        let size = page.photo.size
        Image(uiImage: page.photo)
            .resizable()
            .aspectRatio(contentMode: .fit)
            .overlay {
                GeometryReader { geo in
                    let mapper = FrameMapper(frame: size, view: geo.size, fill: false)
                    ForEach(page.pockets) { pocket in
                        let pts = pocket.quad.points.map(mapper.point)
                        let tint = color(pocket.item.status)
                        Path { p in
                            p.move(to: pts[0])
                            for pt in pts.dropFirst() { p.addLine(to: pt) }
                            p.closeSubpath()
                        }
                        .stroke(tint, style: StrokeStyle(lineWidth: 2.5, lineJoin: .round))
                        let c = mapper.point(pocket.quad.center)
                        badge(pocket.item.status)
                            .position(c)
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .animation(.snappy, value: page.pockets.map(\.item.status))
    }

    private func color(_ s: ScanItem.Status) -> Color {
        switch s {
        case .matching: .white
        case .matched: .up
        case .review: scanYellow
        case .failed: .down
        }
    }

    @ViewBuilder private func badge(_ s: ScanItem.Status) -> some View {
        switch s {
        case .matching:
            ProgressView().controlSize(.small).tint(.white).frame(width: 26, height: 26).background(.black.opacity(0.55), in: Circle())
        case .matched:
            Image(systemName: "checkmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, Color.up).font(.system(size: 24))
        case .review:
            Image(systemName: "questionmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.black, scanYellow).font(.system(size: 24))
        case .failed:
            Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, Color.down).font(.system(size: 24))
        }
    }
}

private struct PocketRow: View {
    let item: ScanItem

    var body: some View {
        HStack(spacing: 12) {
            Image(uiImage: item.photo)
                .resizable().aspectRatio(contentMode: .fill)
                .frame(width: 38, height: 53)
                .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(item.choice?.card.name ?? (item.status == .matching ? "Matching…" : "No match"))
                        .font(.body.weight(.semibold)).lineLimit(1)
                    if item.status == .review { Image(systemName: "questionmark.circle.fill").foregroundStyle(.orange) }
                }
                Text([item.pocket, item.choice?.card.subtitle].compactMap { $0 }.joined(separator: " · "))
                    .font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if item.status == .matching {
                ProgressView()
            } else {
                Text(Fmt.money(item.unitValue)).font(.body.weight(.semibold).monospacedDigit())
            }
        }
    }
}

/// Lock the scanner to one set: its cards win close calls. Handy for a binder or a stack from one set.
@MainActor
struct SetPickerView: View {
    @Binding var selection: SetOption?
    @Environment(\.dismiss) private var dismiss
    @State private var sets: [SetOption] = []
    @State private var query = ""

    private var filtered: [SetOption] {
        let q = Similarity.normalize(query)
        guard !q.isEmpty else { return sets }
        return sets.filter { Similarity.normalize($0.name).contains(q) || Similarity.normalize($0.series).contains(q) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        selection = nil
                        dismiss()
                    } label: {
                        HStack {
                            Text("Any set")
                            Spacer()
                            if selection == nil { Image(systemName: "checkmark").foregroundStyle(.tint) }
                        }
                    }
                    .tint(.primary)
                } footer: {
                    Text("When a scan is a close call, cards from the locked set win.")
                }
                Section {
                    ForEach(filtered) { s in
                        Button {
                            selection = s
                            dismiss()
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(s.name)
                                    Text([s.series, s.released.map { String($0.prefix(4)) }].compactMap { $0 }.joined(separator: " · "))
                                        .font(.footnote).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if selection?.id == s.id { Image(systemName: "checkmark").foregroundStyle(.tint) }
                            }
                        }
                        .tint(.primary)
                    }
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Set name")
            .navigationTitle("Lock to a set")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .task {
                await Catalog.shared.ensureLoaded()
                sets = await Catalog.shared.setOptions()
            }
        }
    }
}
