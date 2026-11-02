import SwiftUI
import SwiftData

/// Review everything from a continuous scanning session before it hits the collection.
@MainActor
struct ScanReviewView: View {
    let model: ScannerModel
    var onDone: (Int) -> Void
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    private var addable: [ScanItem] { model.items.filter { $0.choice != nil } }

    var body: some View {
        NavigationStack {
            List {
                if model.items.contains(where: { $0.status == .review }) {
                    Section {
                        Label("Cards marked with ? had a close second match. Tap to check them.", systemImage: "questionmark.circle.fill")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                Section {
                    ForEach(model.items) { item in
                        NavigationLink {
                            ScanItemEditor(item: item)
                        } label: {
                            ReviewRow(item: item)
                        }
                    }
                    .onDelete { idx in
                        let doomed = idx.map { model.items[$0] }
                        doomed.forEach(model.remove)
                    }
                }
            }
            .navigationTitle("\(model.items.count) scanned")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Keep scanning") { dismiss() } }
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
                    Text(c.card.subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
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

/// Fix a scan: choose the right card/printing, grade, condition and quantity.
@MainActor
struct ScanItemEditor: View {
    @Bindable var item: ScanItem
    @State private var query = ""
    @State private var searching = false

    var body: some View {
        Form {
            Section("Match") {
                ForEach(Array(item.candidates.prefix(8).enumerated()), id: \.element.id) { i, c in
                    Button {
                        withAnimation(.snappy) {
                            item.selected = i
                            item.variant = c.card.variant ?? c.variants.first?.variant
                            item.status = .matched
                        }
                    } label: {
                        CardRow(card: c.card) {
                            VStack(alignment: .trailing, spacing: 2) {
                                Text(Fmt.money(c.card.price)).font(.subheadline.weight(.semibold).monospacedDigit())
                                if i == item.selected { Image(systemName: "checkmark").font(.footnote.weight(.bold)).foregroundStyle(.tint) }
                            }
                        }
                    }
                    .tint(.primary)
                }
                HStack {
                    TextField("Search by name", text: $query).submitLabel(.search).onSubmit(search)
                    if searching { ProgressView() }
                }
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
        .navigationTitle(item.choice?.card.name ?? "Fix match")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func search() {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.count >= 2 else { return }
        searching = true
        Task {
            await Catalog.shared.ensureLoaded()
            let cards = await Catalog.shared.search(q, limit: 20)
            var results: [ScanCandidate] = []
            for c in cards {
                results.append(ScanCandidate(card: c, variants: await Catalog.shared.variants(id: c.id), score: 0.5, reason: "Search"))
            }
            withAnimation(.snappy) {
                if !results.isEmpty {
                    item.candidates = results
                    item.selected = 0
                    item.variant = results[0].card.variant
                    item.status = .matched
                }
                searching = false
            }
        }
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
