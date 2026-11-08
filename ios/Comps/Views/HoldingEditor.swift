import SwiftUI
import SwiftData

/// Create or edit a holding. Editing can also swap in the right card when a scan matched the
/// wrong one (it keeps its place in History), and change the printing.
@MainActor
struct HoldingEditor: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    private let existing: Holding?
    private let card: CardSummary?
    @State private var variants: [VariantPrice]
    /// The right card, picked when the holding was matched to the wrong one.
    @State private var replacement: ScanCandidate?
    @State private var picking = false
    /// The printing the holding started on, to tell when it's been changed.
    @State private var baseVariant = ""

    @State private var variant: String
    @State private var graded: Bool
    @State private var grader: String
    @State private var grade: String
    @State private var condition: String
    @State private var quantity: Int
    @State private var cost: String
    @State private var acquired: Date
    @State private var notes: String

    init(holding: Holding) {
        existing = holding
        card = nil
        _variants = State(initialValue: [])
        _variant = State(initialValue: holding.variant ?? "")
        _baseVariant = State(initialValue: holding.variant ?? "")
        _graded = State(initialValue: holding.isGraded)
        _grader = State(initialValue: holding.grader ?? "PSA")
        _grade = State(initialValue: holding.grade ?? "10")
        _condition = State(initialValue: holding.condition)
        _quantity = State(initialValue: holding.quantity)
        _cost = State(initialValue: holding.costBasis.map { String(format: "%.2f", $0) } ?? "")
        _acquired = State(initialValue: holding.acquiredAt ?? .now)
        _notes = State(initialValue: holding.notes ?? "")
    }

    init(card: CardSummary, variants: [VariantPrice]) {
        existing = nil
        self.card = card
        _variants = State(initialValue: variants)
        _variant = State(initialValue: Catalog.defaultPrinting(variants, card: card.variant) ?? "")
        _graded = State(initialValue: false)
        _grader = State(initialValue: "PSA")
        _grade = State(initialValue: "10")
        _condition = State(initialValue: UserDefaults.standard.string(forKey: Pref.scanCondition) ?? "NM")
        _quantity = State(initialValue: 1)
        _cost = State(initialValue: "")
        _acquired = State(initialValue: .now)
        _notes = State(initialValue: "")
    }

    /// The card being added, or the right card picked for a holding.
    private var shownCard: CardSummary? { replacement?.card ?? card }
    private var title: String { replacement?.card.name ?? existing?.name ?? card?.name ?? "Card" }
    private var subtitle: String { shownCard?.subtitle ?? existing?.subtitle ?? "" }
    private var imageURL: URL? { shownCard?.imageURL ?? URL(string: existing?.imageURL ?? "") }
    private var printingChanged: Bool { existing != nil && variant != baseVariant }

    private var estimate: Double? {
        if let existing, replacement == nil, !printingChanged {
            if !graded { return existing.rawPrice.map { $0 * (CardCondition(rawValue: condition)?.factor ?? 1) } ?? existing.unitValue }
            return existing.unitValue
        }
        let v = variants.first { $0.variant == variant } ?? variants.first
        if graded, let g = (v?.grades ?? shownCard?.grades)?.value(grader: grader, grade: grade) { return g }
        let raw = v?.price ?? shownCard?.price
        return raw.map { $0 * (graded ? 1 : (CardCondition(rawValue: condition)?.factor ?? 1)) }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 14) {
                        CardImage(url: imageURL, name: title, game: Game(id: shownCard?.game ?? existing?.game ?? "other"))
                            .frame(width: 56)
                            .id(imageURL)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(title).font(.headline)
                            Text(subtitle).font(.footnote).foregroundStyle(.secondary)
                            Text("Est. \(Fmt.money(estimate.map { $0 * Double(quantity) }))").font(.subheadline.weight(.semibold).monospacedDigit())
                                .contentTransition(.numericText())
                        }
                    }
                    if existing != nil {
                        Button { picking = true } label: {
                            Label(replacement == nil ? "Wrong card? Change it" : "Pick a different card", systemImage: "arrow.triangle.2.circlepath")
                        }
                    }
                } footer: {
                    if let existing, replacement != nil {
                        Text("Was \(existing.name)\(existing.subtitle.isEmpty ? "" : " · \(existing.subtitle)"). Saves as the new card, in the same place in History.")
                    }
                }

                if variants.count > 1 {
                    Section("Printing") {
                        Picker("Printing", selection: $variant) {
                            ForEach(variants, id: \.variant) { v in Text("\(v.label.isEmpty ? "Standard" : v.label) · \(Fmt.money(v.price))").tag(v.variant) }
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                    }
                }

                Section("Condition") {
                    Toggle("Graded", isOn: $graded.animation(.snappy))
                    if graded {
                        Picker("Grader", selection: $grader) { ForEach(Grader.allCases) { Text($0.rawValue).tag($0.rawValue) } }
                        Picker("Grade", selection: $grade) { ForEach(gradeOptions, id: \.self) { Text($0).tag($0) } }
                    } else {
                        Picker("Condition", selection: $condition) { ForEach(CardCondition.allCases) { Text($0.rawValue).tag($0.rawValue) } }
                            .pickerStyle(.segmented)
                    }
                }

                Section("Details") {
                    Stepper("Quantity: \(quantity)", value: $quantity, in: 1...999)
                    HStack {
                        Text("Paid each")
                        Spacer()
                        TextField("$0.00", text: $cost).keyboardType(.decimalPad).multilineTextAlignment(.trailing).frame(maxWidth: 140)
                    }
                    DatePicker("Acquired", selection: $acquired, displayedComponents: .date)
                    TextField("Notes (cert #, where you got it)", text: $notes, axis: .vertical)
                }

                if let existing {
                    Section {
                        Button("Remove from Collection", role: .destructive) {
                            Portfolio.remove(existing, context: context)
                            dismiss()
                        }
                    }
                }
            }
            .navigationTitle(existing == nil ? "Add Card" : "Edit")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $picking) {
                CardPicker(query: existing?.name ?? "") { c in
                    withAnimation(.snappy) {
                        replacement = c
                        variants = c.variants
                        variant = Catalog.defaultPrinting(c) ?? ""
                    }
                }
            }
            .task {
                // Printings for a card already in the collection (the scan's pick may be the wrong one).
                guard let existing, variants.isEmpty else { return }
                await Catalog.shared.ensureLoaded()
                let options = await Catalog.shared.variants(id: existing.cardID)
                if variant.isEmpty, let first = options.first {
                    variant = first.variant
                    baseVariant = first.variant
                }
                variants = options
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(existing == nil ? "Add" : "Save") { save() }.bold() }
            }
        }
        .presentationDragIndicator(.visible)
    }

    private func save() {
        let paid = Double(cost.replacingOccurrences(of: "$", with: "").replacingOccurrences(of: ",", with: ""))
        if let h = existing {
            if let c = replacement?.card {
                h.cardID = c.id
                h.game = c.game
                h.name = c.name
                h.setName = c.setName
                h.number = c.number
                h.imageURL = ImageURL.original(c.image)
                h.change7d = nil
            }
            if replacement != nil || printingChanged {
                let v = variants.first { $0.variant == variant } ?? variants.first
                h.rawPrice = v?.price ?? replacement?.card.price ?? h.rawPrice
                h.unitValue = estimate
                h.priceBasis = graded ? nil : "raw"
            }
            h.variant = variant.isEmpty ? nil : variant
            h.grader = graded ? grader : nil
            h.grade = graded ? grade : nil
            h.condition = graded ? "NM" : condition
            h.quantity = quantity
            h.costBasis = paid
            h.acquiredAt = acquired
            h.notes = notes.isEmpty ? nil : notes
            if !graded, let raw = h.rawPrice { h.unitValue = raw * (CardCondition(rawValue: condition)?.factor ?? 1); h.priceBasis = "raw" }
            h.touch()
        } else if let card {
            let h = Holding(cardID: card.id, game: card.game, name: card.name, setName: card.setName, number: card.number,
                            imageURL: ImageURL.original(card.image), variant: variant.isEmpty ? nil : variant,
                            grader: graded ? grader : nil, grade: graded ? grade : nil, condition: graded ? "NM" : condition,
                            quantity: quantity, costBasis: paid, acquiredAt: acquired, notes: notes.isEmpty ? nil : notes, unitValue: estimate)
            h.rawPrice = (variants.first { $0.variant == variant } ?? variants.first)?.price ?? card.price
            h.priceBasis = graded ? nil : "raw"
            context.insert(h)
        }
        try? context.save()
        Portfolio.snapshot(context: context)
        dismiss()
        Task { await Portfolio.refreshPrices(context: context) }
    }
}

/// Search the catalog for the right card (when a scan matched the wrong one).
@MainActor
private struct CardPicker: View {
    @Environment(\.dismiss) private var dismiss
    @State var query: String
    var onPick: (ScanCandidate) -> Void
    @State private var results: [ScanCandidate] = []
    @State private var searching = false

    init(query: String, onPick: @escaping (ScanCandidate) -> Void) {
        _query = State(initialValue: query)
        self.onPick = onPick
    }

    var body: some View {
        NavigationStack {
            List {
                if !searching && results.isEmpty {
                    Text(query.count < 2 ? "Type a name, or a number like 4/102." : "No cards found.")
                        .foregroundStyle(.secondary)
                }
                ForEach(results) { c in
                    Button {
                        onPick(c)
                        dismiss()
                    } label: {
                        HStack(spacing: 12) {
                            CardImage(url: c.card.imageURL, name: c.card.name, game: c.card.gameKind, corner: 4).frame(width: 46)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.card.name).font(.body.weight(.semibold)).lineLimit(2)
                                Text(c.card.subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                                if let r = c.card.rarity { Text(r).font(.caption).foregroundStyle(.tertiary).lineLimit(1) }
                            }
                            Spacer(minLength: 8)
                            Text(Fmt.money(c.card.price)).font(.subheadline.weight(.semibold).monospacedDigit())
                        }
                    }
                    .tint(.primary)
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Name, set or number")
            .navigationTitle("Right card")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .task(id: query) {
                let q = query.trimmingCharacters(in: .whitespaces)
                guard q.count >= 2 else { results = []; return }
                searching = true
                try? await Task.sleep(for: .milliseconds(200))
                guard !Task.isCancelled else { return }
                await Catalog.shared.ensureLoaded()
                let found = await Catalog.shared.lookup(q, setId: nil, limit: 60)
                guard !Task.isCancelled else { return }
                results = found
                searching = false
            }
        }
    }
}
