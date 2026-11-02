import SwiftUI
import SwiftData

/// Create or edit a holding.
@MainActor
struct HoldingEditor: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    private let existing: Holding?
    private let card: CardSummary?
    private let variants: [VariantPrice]

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
        variants = []
        _variant = State(initialValue: holding.variant ?? "")
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
        self.variants = variants
        _variant = State(initialValue: card.variant ?? variants.first?.variant ?? "")
        _graded = State(initialValue: false)
        _grader = State(initialValue: "PSA")
        _grade = State(initialValue: "10")
        _condition = State(initialValue: UserDefaults.standard.string(forKey: Pref.scanCondition) ?? "NM")
        _quantity = State(initialValue: 1)
        _cost = State(initialValue: "")
        _acquired = State(initialValue: .now)
        _notes = State(initialValue: "")
    }

    private var title: String { existing?.name ?? card?.name ?? "Card" }

    private var estimate: Double? {
        if let existing, !graded { return existing.rawPrice.map { $0 * (CardCondition(rawValue: condition)?.factor ?? 1) } ?? existing.unitValue }
        if let existing { return existing.unitValue }
        let v = variants.first { $0.variant == variant } ?? variants.first
        if graded, let g = (v?.grades ?? card?.grades)?.value(grader: grader, grade: grade) { return g }
        let raw = v?.price ?? card?.price
        return raw.map { $0 * (graded ? 1 : (CardCondition(rawValue: condition)?.factor ?? 1)) }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 14) {
                        CardImage(url: card?.imageURL ?? URL(string: existing?.imageURL ?? ""), name: title, game: Game(id: card?.game ?? existing?.game ?? "other"))
                            .frame(width: 56)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(title).font(.headline)
                            Text(card?.subtitle ?? existing?.subtitle ?? "").font(.footnote).foregroundStyle(.secondary)
                            Text("Est. \(Fmt.money(estimate.map { $0 * Double(quantity) }))").font(.subheadline.weight(.semibold).monospacedDigit())
                                .contentTransition(.numericText())
                        }
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
