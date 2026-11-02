import SwiftUI
import SwiftData
import AudioToolbox

/// One scanned card waiting in the tray.
@Observable
final class ScanItem: Identifiable {
    enum Status { case matching, matched, review, failed }

    let id = UUID()
    let photo: UIImage
    var status: Status = .matching
    var candidates: [ScanCandidate] = []
    var selected: Int = 0
    var variant: String?
    var grader: String?
    var grade: String?
    var condition: String
    var quantity = 1

    init(photo: UIImage, condition: String) {
        self.photo = photo
        self.condition = condition
    }

    var choice: ScanCandidate? { candidates.indices.contains(selected) ? candidates[selected] : nil }

    var unitValue: Double? {
        guard let c = choice else { return nil }
        let v = c.variants.first { $0.variant == variant } ?? c.variants.first
        if grader != nil, let g = v?.grades?.value(grader: grader, grade: grade) ?? c.card.grades?.value(grader: grader, grade: grade) { return g }
        let raw = v?.price ?? c.card.price
        return raw.map { $0 * (grader == nil ? (CardCondition(rawValue: condition)?.factor ?? 1) : 1) }
    }
}

@MainActor
@Observable
final class ScannerModel {
    enum Mode: String, CaseIterable { case continuous = "Continuous", single = "Single" }
    enum Phase: Equatable { case starting, denied, searching, steady, reading, matched(String), noMatch }

    private(set) var mode: Mode = .continuous
    var phase: Phase = .starting
    var quad: Quad?
    var frameSize: CGSize = CGSize(width: 1080, height: 1920)
    var items: [ScanItem] = []
    private(set) var torch = false
    var game: Game?
    private(set) var paused = false
    var singleResult: ScanItem?
    var flash = 0

    func setMode(_ m: Mode) {
        mode = m
        engine.continuous = m == .continuous
        engine.reset()
        if m == .continuous, singleResult == nil { setPaused(false) }
    }

    func setTorch(_ on: Bool) {
        torch = on
        camera.setTorch(on)
    }

    func setPaused(_ p: Bool) {
        paused = p
        engine.isPaused = p
    }

    let camera = CameraController()
    private let engine = ScanEngine()
    private var defaultCondition: String { UserDefaults.standard.string(forKey: Pref.scanCondition) ?? "NM" }
    private var haptics: Bool { UserDefaults.standard.object(forKey: Pref.haptics) as? Bool ?? true }
    private var sound: Bool { UserDefaults.standard.bool(forKey: Pref.scanSound) }
    private let light = UIImpactFeedbackGenerator(style: .light)
    private let notify = UINotificationFeedbackGenerator()

    var total: Double { items.reduce(0) { sum, item in sum + (item.unitValue ?? 0) * Double(item.quantity) } }
    var readyCount: Int { items.filter { $0.status == .matched || $0.status == .review }.count }

    init() {
        if let g = UserDefaults.standard.string(forKey: Pref.scanGame), let game = Game(rawValue: g) { self.game = game }
        engine.continuous = true
        let engine = self.engine
        camera.onFrame = { buffer in engine.process(buffer) }
        engine.onEvent = { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        }
    }

    func start() async {
        guard await CameraController.requestAccess() else { phase = .denied; return }
        light.prepare()
        notify.prepare()
        camera.start()
        phase = .searching
    }

    func stop() {
        setTorch(false)
        camera.stop()
    }

    func shutter() {
        engine.captureRequested = true
    }

    private func handle(_ event: ScanEngine.Event) {
        switch event {
        case .quad(let q, let size):
            frameSize = size
            // Light smoothing so the outline glides instead of jittering.
            if let q, let cur = quad, q.distance(to: cur) < 0.1 { quad = cur.lerp(to: q, 0.6) } else { quad = q }
            if q == nil, phase == .steady || phase == .noMatch { phase = .searching }
        case .steady:
            if phase == .searching { phase = .steady }
        case .reading:
            phase = .reading
            if haptics { light.impactOccurred(intensity: 0.7) }
        case .captured(let card):
            flash += 1
            if sound { AudioServicesPlaySystemSound(1104) }
            let item = ScanItem(photo: card.image, condition: defaultCondition)
            if mode == .continuous {
                withAnimation(.spring(response: 0.42, dampingFraction: 0.8)) { items.insert(item, at: 0) }
            } else {
                setPaused(true)
            }
            Task { await resolve(item, lines: card.lines) }
        case .skippedDuplicate:
            break
        }
    }

    private func resolve(_ item: ScanItem, lines: [OCRLine]) async {
        let result = await CardResolver.resolve(lines: lines, hint: game)
        let autoAccept = UserDefaults.standard.object(forKey: Pref.autoAccept) as? Double ?? 0.8
        withAnimation(.snappy) {
            item.candidates = result.candidates
            item.grader = result.features.grader
            item.grade = result.features.grade
            if let top = result.candidates.first {
                item.variant = top.card.variant ?? top.variants.first?.variant
                let clear = result.candidates.count < 2 || top.score - result.candidates[1].score > 0.08
                item.status = top.score >= autoAccept && clear ? .matched : .review
                phase = .matched(top.card.name)
            } else {
                item.status = .failed
                phase = .noMatch
            }
        }
        if haptics { item.status == .failed ? notify.notificationOccurred(.warning) : notify.notificationOccurred(.success) }
        if mode == .single { singleResult = item }
    }

    func remove(_ item: ScanItem) {
        withAnimation(.snappy) { items.removeAll { $0.id == item.id } }
    }

    func resumeSingle() {
        singleResult = nil
        engine.reset()
        setPaused(false)
        phase = .searching
    }

    /// Adds scanned cards to the collection, merging repeats into quantities.
    @discardableResult
    func commit(_ list: [ScanItem], context: ModelContext) -> Int {
        var added = 0
        var merged: [String: Holding] = [:]
        for item in list {
            guard let c = item.choice else { continue }
            let key = [c.card.id, item.variant ?? "", item.grader ?? "", item.grade ?? "", item.condition].joined(separator: "|")
            if let existing = merged[key] {
                existing.quantity += item.quantity
                continue
            }
            let h = Holding(cardID: c.card.id, game: c.card.game, name: c.card.name, setName: c.card.setName, number: c.card.number,
                            imageURL: ImageURL.original(c.card.image), variant: item.variant, grader: item.grader, grade: item.grade,
                            condition: item.condition, quantity: item.quantity, unitValue: item.unitValue)
            h.rawPrice = (c.variants.first { $0.variant == item.variant } ?? c.variants.first)?.price ?? c.card.price
            h.priceBasis = item.grader == nil ? "raw" : nil
            context.insert(h)
            merged[key] = h
            added += item.quantity
        }
        try? context.save()
        Portfolio.snapshot(context: context)
        withAnimation(.snappy) { items.removeAll { item in list.contains { $0.id == item.id } } }
        return added
    }
}
