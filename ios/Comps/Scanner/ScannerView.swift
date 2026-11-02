import SwiftUI
import SwiftData

@MainActor
struct ScannerView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @State private var model = ScannerModel()
    @State private var showReview = false
    @State private var flashOpacity = 0.0
    @State private var toast: String?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            CameraPreview(session: model.camera.session) { point in model.camera.focus(at: point) }
                .ignoresSafeArea()
            DetectionOverlay(quad: model.quad, frameSize: model.frameSize, tint: outlineTint)
                .ignoresSafeArea()
            Color.white.opacity(flashOpacity).ignoresSafeArea().allowsHitTesting(false)

            VStack(spacing: 0) {
                topBar
                Spacer()
                statusPill.padding(.bottom, 14)
                if model.mode == .continuous && !model.items.isEmpty { tray.transition(.move(edge: .bottom).combined(with: .opacity)) }
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
            Text("Pokémon")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 14).frame(height: 36)
                .background(.ultraThinMaterial, in: Capsule())
            Spacer()
            CircleButton(system: model.torch ? "flashlight.on.fill" : "flashlight.off.fill", active: model.torch) { model.setTorch(!model.torch) }
        }
        .padding(.horizontal, 18)
        .padding(.top, 8)
    }

    private var statusText: String {
        switch model.phase {
        case .starting: "Starting camera"
        case .denied: "Camera access is off"
        case .searching: model.paused ? "Paused" : "Point at a card"
        case .steady: model.mode == .single ? "Tap the shutter" : "Hold steady"
        case .reading: "Reading…"
        case .matched(let name): name
        case .noMatch: "No match — try more light"
        }
    }

    private var statusPill: some View {
        HStack(spacing: 8) {
            if model.phase == .reading { ProgressView().controlSize(.small).tint(.white) }
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
            HStack(spacing: 22) {
                ForEach(ScannerModel.Mode.allCases, id: \.self) { m in
                    Button {
                        withAnimation(.snappy) { model.setMode(m) }
                    } label: {
                        Text(m.rawValue.uppercased())
                            .font(.footnote.weight(.semibold))
                            .tracking(1.2)
                            .foregroundStyle(model.mode == m ? Color(red: 1, green: 0.84, blue: 0.04) : .white.opacity(0.8))
                    }
                }
            }
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
                ShutterButton(mode: model.mode, paused: model.paused, ready: model.phase == .steady || model.phase == .searching) {
                    if model.mode == .single { model.shutter() } else { model.setPaused(!model.paused) }
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
    var ready: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle().strokeBorder(.white, lineWidth: 4).frame(width: 78, height: 78)
                if mode == .single {
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
        .accessibilityLabel(mode == .single ? "Capture" : paused ? "Resume scanning" : "Pause scanning")
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
