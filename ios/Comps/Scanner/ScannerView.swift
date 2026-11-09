import SwiftUI
import SwiftData

@MainActor
struct ScannerView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = ScannerModel()
    @State private var showReview = false
    @State private var flashOpacity = 0.0
    @State private var toast: String?
    @State private var pickingSet = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            CameraPreview(session: model.camera.session, fill: model.mode != .binder,
                          onTap: { device, view in model.tapFocus(device: device, view: view) },
                          onPinch: { model.pinch($0) })
                .ignoresSafeArea()
            // Softens the moment the camera switches between card and page set-ups.
            Rectangle().fill(.ultraThinMaterial).ignoresSafeArea()
                .opacity(model.switching ? 1 : 0)
                .animation(.easeInOut(duration: 0.2), value: model.switching)
                .allowsHitTesting(false)
            if let mark = model.focusMark {
                FocusMark().position(mark.point).id(mark.id).ignoresSafeArea().allowsHitTesting(false)
            }
            if model.mode == .binder {
                BinderOverlay(layout: model.layout, quads: model.pageQuads, frameSize: model.frameSize)
                    .ignoresSafeArea()
                    .transition(.opacity)
            } else {
                DetectionOverlay(quad: model.quad, frameSize: model.frameSize, tint: outlineTint, onGuide: { model.setGuide($0) })
                    .ignoresSafeArea()
                    .transition(.opacity)
            }
            Color.white.opacity(flashOpacity).ignoresSafeArea().allowsHitTesting(false)

            VStack(spacing: 0) {
                topBar
                Spacer()
                statusPill.padding(.bottom, 14)
                if model.mode != .single && !model.items.isEmpty { tray.transition(.move(edge: .bottom).combined(with: .opacity)) }
                controls
            }

            if model.phase == .denied { deniedView }
            if let toast {
                Text(toast)
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .frame(maxHeight: .infinity, alignment: .top)
                    .padding(.top, 70)
            }
        }
        .preferredColorScheme(.dark)
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .task { await model.start() }
        .onDisappear { model.stop() }
        // Scanning holds still while the review list is open, so cards don't arrive mid-edit.
        .onChange(of: showReview) { _, open in
            if open { model.beginReview() } else { model.endReview() }
        }
        .onChange(of: scenePhase) { _, phase in if phase != .active { model.saveTray() } }
        .onChange(of: model.notice?.id) {
            if let text = model.notice?.text { show(text) }
        }
        .onChange(of: model.flash) {
            flashOpacity = 0.55
            withAnimation(.easeOut(duration: 0.35)) { flashOpacity = 0 }
        }
        .sheet(isPresented: $showReview) {
            ScanReviewView(model: model) { added in
                showReview = false
                show("Added \(added) card\(added == 1 ? "" : "s")")
            }
        }
        .sheet(item: $model.singleResult, onDismiss: { model.resumeSingle() }) { item in
            SingleResultSheet(item: item) {
                let n = model.commit([item], context: context)
                model.singleResult = nil
                show(n > 0 ? "Added \(item.choice?.card.name ?? "card")" : "Nothing added")
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(item: $model.page, onDismiss: { model.closePage() }) { page in
            BinderPageView(page: page, model: model) { added in
                model.page = nil
                show("Added \(added) card\(added == 1 ? "" : "s")")
            }
            .presentationDetents([.large])
        }
        .sheet(isPresented: $pickingSet) {
            SetPickerView(selection: $model.lockedSet)
        }
    }

    private var outlineTint: Color {
        switch model.phase {
        case .reading: Color(red: 1, green: 0.84, blue: 0.04)
        case .matched: Color.up
        case .noMatch: Color.down
        default: .white
        }
    }

    private func show(_ message: String) {
        withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) { toast = message }
        Task {
            try? await Task.sleep(for: .seconds(1.8))
            withAnimation(.easeOut(duration: 0.25)) { toast = nil }
        }
    }

    // MARK: Pieces

    private var topBar: some View {
        HStack {
            CircleButton(system: "xmark") { dismiss() }
            Spacer()
            Button { pickingSet = true } label: {
                HStack(spacing: 6) {
                    Image(systemName: model.lockedSet == nil ? "square.stack.3d.up" : "lock.fill")
                        .font(.system(size: 12, weight: .semibold))
                    Text(model.lockedSet?.name ?? "All sets")
                        .lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold)).opacity(0.7)
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(model.lockedSet == nil ? .white : .black)
                .padding(.horizontal, 14).frame(height: 36)
                .background(model.lockedSet == nil ? AnyShapeStyle(.ultraThinMaterial) : AnyShapeStyle(Color(red: 1, green: 0.84, blue: 0.04)), in: Capsule())
                .contentTransition(.opacity)
            }
            .pressable()
            .frame(maxWidth: 230)
            .accessibilityLabel(model.lockedSet.map { "Locked to \($0.name)" } ?? "Lock to a set")
            Spacer()
            CircleButton(system: model.torch ? "flashlight.on.fill" : "flashlight.off.fill", active: model.torch) { model.setTorch(!model.torch) }
        }
        .padding(.horizontal, 18)
        .padding(.top, 8)
    }

    private var statusText: String {
        if model.mode == .binder {
            if model.readingPage { return "Reading page…" }
            switch model.phase {
            case .starting: return "Starting camera"
            case .denied: return "Camera access is off"
            case .reading: return "Taking photo…"
            case .noMatch: return "No cards found — fill the frame"
            default:
                let n = model.pageQuads.count
                return n == 0 ? "Fit the page inside the guide" : "\(n) card\(n == 1 ? "" : "s") in view · tap to read"
            }
        }
        return switch model.phase {
        case .starting: "Starting camera"
        case .denied: "Camera access is off"
        case .searching: model.paused ? "Paused" : model.mode == .single ? "Card in the guide, then tap the shutter" : "Point at a card"
        case .steady: model.mode == .single ? "Tap the shutter" : "Hold steady"
        case .reading: "Reading…"
        case .matched(let name): name
        case .noMatch: "No match — try more light"
        }
    }

    private var statusPill: some View {
        HStack(spacing: 8) {
            if model.phase == .reading || model.readingPage { ProgressView().controlSize(.small).tint(.white) }
            Text(statusText)
                .font(.subheadline.weight(.semibold))
                .contentTransition(.opacity)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 16).frame(height: 36)
        .background(.ultraThinMaterial, in: Capsule())
        .animation(.snappy, value: statusText)
    }

    private var tray: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("\(model.items.count) scanned").font(.footnote.weight(.semibold))
                Text(Fmt.money(model.total)).font(.footnote.weight(.semibold).monospacedDigit()).foregroundStyle(.white.opacity(0.7))
                    .contentTransition(.numericText(value: model.total))
                Spacer()
                Button("Review") { showReview = true }.font(.footnote.weight(.semibold))
            }
            .foregroundStyle(.white)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 8) {
                    ForEach(model.items) { item in
                        TrayThumb(item: item)
                            .onTapGesture { showReview = true }
                            .transition(.asymmetric(insertion: .scale(scale: 0.4).combined(with: .opacity), removal: .opacity))
                    }
                }
            }
            .frame(height: 84)
        }
        .padding(12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.bottom, 10)
    }

    private var controls: some View {
        VStack(spacing: 16) {
            if model.mode == .binder {
                HStack(spacing: 6) {
                    ForEach(BinderLayout.allCases) { l in
                        Button {
                            withAnimation(.snappy) { model.setLayout(l) }
                        } label: {
                            Text("\(l.count)-pocket")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(model.layout == l ? .black : .white)
                                .padding(.horizontal, 12).frame(height: 28)
                                .background(model.layout == l ? AnyShapeStyle(Color.white) : AnyShapeStyle(.ultraThinMaterial), in: Capsule())
                        }
                        .pressable()
                    }
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            if model.focusLocked { focusBar.transition(.move(edge: .bottom).combined(with: .opacity)) }
            zoomBar
            modePicker
            HStack {
                Button { showReview = true } label: {
                    Group {
                        if let first = model.items.first {
                            Image(uiImage: first.photo).resizable().aspectRatio(contentMode: .fill)
                        } else {
                            Color.white.opacity(0.08)
                        }
                    }
                    .frame(width: 46, height: 64)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(.white.opacity(0.3), lineWidth: 1))
                }
                .disabled(model.items.isEmpty)
                .frame(width: 80)

                Spacer()
                ShutterButton(mode: model.mode, paused: model.paused, busy: model.readingPage,
                              ready: model.mode == .binder ? !model.pageQuads.isEmpty : model.phase == .steady || model.phase == .searching) {
                    model.shutter()
                }
                Spacer()

                Button { showReview = true } label: {
                    Text(model.items.isEmpty ? "Done" : "Add \(model.readyCount)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(model.items.isEmpty ? .white.opacity(0.5) : .black)
                        .padding(.horizontal, 14).frame(height: 36)
                        .background(model.items.isEmpty ? AnyShapeStyle(.ultraThinMaterial) : AnyShapeStyle(Color(red: 1, green: 0.84, blue: 0.04)), in: Capsule())
                        .contentTransition(.numericText())
                }
                .disabled(model.items.isEmpty)
                .frame(width: 80)
            }
            .padding(.horizontal, 20)
        }
        .padding(.bottom, 18)
    }

    /// Quick zoom levels (pinch the preview for anything in between).
    /// Continuous · Single · Binder: big targets, and a swipe across it moves to the next mode.
    private var modePicker: some View {
        let modes = ScannerModel.Mode.allCases
        return HStack(spacing: 2) {
            ForEach(modes, id: \.self) { m in
                let on = model.mode == m
                Button {
                    withAnimation(.snappy) { model.setMode(m) }
                } label: {
                    Text(m.rawValue.uppercased())
                        .font(.caption.weight(.bold))
                        .tracking(1)
                        .foregroundStyle(on ? Color.black : Color.white.opacity(0.85))
                        .frame(minWidth: 94, minHeight: 38)
                        .background { if on { Capsule().fill(Color(red: 1, green: 0.84, blue: 0.04)) } }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(3)
        .background(.ultraThinMaterial, in: Capsule())
        .gesture(DragGesture(minimumDistance: 20).onEnded { v in
            guard abs(v.translation.width) > 40, let i = modes.firstIndex(of: model.mode) else { return }
            let next = v.translation.width < 0 ? min(i + 1, modes.count - 1) : max(i - 1, 0)
            withAnimation(.snappy) { model.setMode(modes[next]) }
        })
        .sensoryFeedback(.selection, trigger: model.mode)
    }

    private var zoomBar: some View {
        // 0.5× is the ultra-wide: wider, and it focuses much closer (a phone on a stand).
        let steps: [CGFloat] = model.minZoom < 0.9 ? [(model.minZoom * 10).rounded() / 10, 1, 2, 3] : [1, 1.5, 2, 3]
        let nearest = steps.min { abs($0 - model.zoom) < abs($1 - model.zoom) } ?? 1
        return HStack(spacing: 8) {
            ForEach(steps, id: \.self) { z in
                let active = z == nearest
                Button { model.setZoom(z) } label: {
                    Text(active ? Self.zoomText(model.zoom) : Self.zoomText(z))
                        .font(.system(size: active ? 13 : 12, weight: .bold).monospacedDigit())
                        .foregroundStyle(active ? Color(red: 1, green: 0.84, blue: 0.04) : .white)
                        .frame(width: active ? 44 : 36, height: active ? 44 : 36)
                        .background(.ultraThinMaterial, in: Circle())
                        .contentTransition(.numericText())
                }
                .pressable()
                .accessibilityLabel("Zoom \(Self.zoomText(z))")
            }
        }
        .animation(.snappy, value: nearest)
        .sensoryFeedback(.selection, trigger: nearest)
    }

    /// As the Camera app writes it: .5×, 1×, 1.5×.
    private static func zoomText(_ z: CGFloat) -> String {
        let r = (z * 10).rounded() / 10
        if r < 1 { return ".\(Int((r * 10).rounded()))×" }
        return r == r.rounded() ? "\(Int(r))×" : String(format: "%.1f×", r)
    }

    /// Shown once focus is held (tap the preview): fine-tune it, or go back to automatic.
    /// The multi-lens camera can't be set by hand, so there it holds the tapped spot instead.
    private var focusBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "scope").font(.system(size: 14, weight: .semibold))
            if model.manualFocus {
                Image(systemName: "flower").font(.system(size: 11)).opacity(0.7)
                Slider(value: Binding(get: { Double(model.lensPosition) }, set: { model.setLens(Float($0)) }), in: 0...1)
                    .tint(Color(red: 1, green: 0.84, blue: 0.04))
                Image(systemName: "mountain.2").font(.system(size: 11)).opacity(0.7)
            } else {
                Text("Focus held · tap again to move it")
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 0)
            }
            Button("Auto") { withAnimation(.snappy) { model.autoFocus() } }
                .font(.footnote.weight(.bold))
                .foregroundStyle(.black)
                .padding(.horizontal, 10).frame(height: 28)
                .background(Color(red: 1, green: 0.84, blue: 0.04), in: Capsule())
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 14).frame(height: 44)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(.horizontal, 20)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Focus")
    }

    private var deniedView: some View {
        VStack(spacing: 14) {
            Image(systemName: "camera.fill").font(.system(size: 40)).foregroundStyle(.white.opacity(0.8))
            Text("Camera access is off").font(.title3.weight(.semibold)).foregroundStyle(.white)
            Text("Allow camera access in Settings to scan cards.").font(.subheadline).foregroundStyle(.white.opacity(0.7))
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(30)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.black)
    }
}

/// The yellow square where you tapped to focus.
private struct FocusMark: View {
    @State private var settled = false
    @State private var gone = false

    var body: some View {
        RoundedRectangle(cornerRadius: 4, style: .continuous)
            .stroke(Color(red: 1, green: 0.84, blue: 0.04), lineWidth: 1.5)
            .frame(width: 76, height: 76)
            .scaleEffect(settled ? 1 : 1.35)
            .opacity(gone ? 0 : 1)
            .onAppear {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) { settled = true }
                withAnimation(.easeOut(duration: 0.4).delay(1.1)) { gone = true }
            }
    }
}

private struct CircleButton: View {
    var system: String
    var active = false
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: system)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(active ? .black : .white)
                .frame(width: 40, height: 40)
                .background(active ? AnyShapeStyle(Color.white) : AnyShapeStyle(.ultraThinMaterial), in: Circle())
                .contentTransition(.symbolEffect(.replace))
        }
        .pressable()
    }
}

private struct ShutterButton: View {
    var mode: ScannerModel.Mode
    var paused: Bool
    var busy = false
    var ready: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle().strokeBorder(.white, lineWidth: 4).frame(width: 78, height: 78)
                if mode == .binder {
                    Circle().fill(.white).frame(width: 64, height: 64).opacity(ready ? 1 : 0.7)
                    if busy {
                        ProgressView().tint(.black)
                    } else {
                        Image(systemName: "square.grid.3x3.fill")
                            .font(.system(size: 22, weight: .semibold))
                            .foregroundStyle(.black)
                    }
                } else if mode == .single {
                    Circle().fill(.white).frame(width: 64, height: 64).opacity(ready ? 1 : 0.6)
                } else {
                    Circle().fill(paused ? Color.white : Color(red: 1, green: 0.84, blue: 0.04)).frame(width: 64, height: 64)
                    Image(systemName: paused ? "play.fill" : "pause.fill")
                        .font(.system(size: 22, weight: .bold))
                        .foregroundStyle(.black)
                        .contentTransition(.symbolEffect(.replace))
                }
            }
        }
        .pressable()
        .sensoryFeedback(.impact(weight: .medium), trigger: paused)
        .disabled(busy)
        .accessibilityLabel(mode == .binder ? "Read page" : mode == .single ? "Capture" : paused ? "Resume scanning" : "Pause scanning")
    }
}

private struct TrayThumb: View {
    let item: ScanItem

    var body: some View {
        VStack(spacing: 4) {
            ZStack(alignment: .topTrailing) {
                Group {
                    if let c = item.choice {
                        CardImage(url: c.card.imageURL, name: c.card.name, game: c.card.gameKind, corner: 5)
                    } else {
                        Image(uiImage: item.photo).resizable().aspectRatio(63.0 / 88.0, contentMode: .fill)
                            .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                    }
                }
                .frame(width: 46, height: 64)
                statusDot.offset(x: 4, y: -4)
            }
            Text(item.unitValue.map { Fmt.money($0) } ?? (item.status == .matching ? "…" : "—"))
                .font(.caption2.weight(.semibold).monospacedDigit())
                .foregroundStyle(.white.opacity(0.85))
        }
    }

    @ViewBuilder private var statusDot: some View {
        switch item.status {
        case .matching: ProgressView().controlSize(.mini).tint(.white).frame(width: 16, height: 16).background(.black.opacity(0.5), in: Circle())
        case .matched: Image(systemName: "checkmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, Color.up).font(.system(size: 16))
        case .review: Image(systemName: "questionmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.black, Color(red: 1, green: 0.84, blue: 0.04)).font(.system(size: 16))
        case .failed: Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, Color.down).font(.system(size: 16))
        }
    }
}
