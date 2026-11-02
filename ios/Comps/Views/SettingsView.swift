import SwiftUI
import SwiftData
import Vision

@MainActor
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @AppStorage(Pref.serverURL) private var serverURL = ""
    @AppStorage(Pref.serverToken) private var token = ""
    @AppStorage(Pref.pokemonKey) private var pokemonKey = ""
    @AppStorage(Pref.haptics) private var haptics = true
    @AppStorage(Pref.scanSound) private var sound = false
    @AppStorage(Pref.scanCondition) private var scanCondition = "NM"
    @AppStorage(Pref.autoAccept) private var autoAccept = 0.8
    @AppStorage(Pref.lastSync) private var lastSync = 0.0

    @State private var status: ConnectionStatus = .idle
    @State private var showPairing = false
    @State private var syncing = false

    enum ConnectionStatus: Equatable { case idle, checking, ok(String), failed(String) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://192.168.1.20:8787", text: $serverURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Access token (optional)", text: $token)
                    Button { showPairing = true } label: { Label("Scan pairing code", systemImage: "qrcode.viewfinder") }
                    HStack {
                        Button("Test connection") { Task { await test() } }
                            .disabled(serverURL.isEmpty || status == .checking)
                        Spacer()
                        statusView
                    }
                } header: {
                    Text("Comps server")
                } footer: {
                    Text("Run the server on your computer and open its Settings page — it shows this address and a pairing code. Without a server, scanning and raw prices still work.")
                }

                if !serverURL.isEmpty {
                    Section("Sync") {
                        HStack {
                            Text("Last synced")
                            Spacer()
                            Text(lastSync > 0 ? Date(millis: lastSync).formatted(.relative(presentation: .named)) : "Never").foregroundStyle(.secondary)
                        }
                        Button {
                            Task {
                                syncing = true
                                defer { syncing = false }
                                _ = try? await Portfolio.sync(context: context)
                                await Portfolio.refreshPrices(context: context)
                            }
                        } label: {
                            HStack { Text("Sync now"); if syncing { Spacer(); ProgressView() } }
                        }
                        .disabled(syncing)
                    }
                }

                Section {
                    Picker("Default condition", selection: $scanCondition) {
                        ForEach(CardCondition.allCases) { Text($0.rawValue).tag($0.rawValue) }
                    }
                    VStack(alignment: .leading) {
                        HStack { Text("Auto-accept matches"); Spacer(); Text("\(Int(autoAccept * 100))%+").foregroundStyle(.secondary).monospacedDigit() }
                        Slider(value: $autoAccept, in: 0.5...0.98)
                    }
                    Toggle("Haptics", isOn: $haptics)
                    Toggle("Shutter sound", isOn: $sound)
                } header: {
                    Text("Scanning")
                } footer: {
                    Text("Scans below the auto-accept confidence are marked for review instead of being added blindly.")
                }

                Section {
                    SecureField("Pokémon TCG API key (optional)", text: $pokemonKey)
                } header: {
                    Text("Direct lookups")
                } footer: {
                    Text("Used when no server is connected. A free key from dev.pokemontcg.io raises the rate limit.")
                }

                Section {
                    LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0")
                    Link("Card data: Pokémon TCG API, Scryfall, YGOPRODeck", destination: URL(string: "https://pokemontcg.io")!)
                        .font(.footnote)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $showPairing) {
                PairingScanner { url, tok in
                    serverURL = url
                    if let tok { token = tok }
                    showPairing = false
                    lastSync = 0
                    Task { await test() }
                }
            }
        }
    }

    @ViewBuilder private var statusView: some View {
        switch status {
        case .idle: EmptyView()
        case .checking: ProgressView()
        case .ok(let s): Label(s, systemImage: "checkmark.circle.fill").foregroundStyle(Color.up).font(.footnote)
        case .failed(let s): Text(s).foregroundStyle(Color.down).font(.footnote).lineLimit(2)
        }
    }

    private func test() async {
        guard let api = APIClient.current else { status = .failed("Invalid address"); return }
        status = .checking
        do {
            let s = try await api.status()
            withAnimation { status = .ok("\(s.counts.valued.formatted()) prices\(s.demo ? " · sample" : "")") }
        } catch {
            withAnimation { status = .failed(error.localizedDescription) }
        }
    }
}

/// Reads the QR code on the server's Settings page: comps://connect?url=…&token=…
@MainActor
struct PairingScanner: View {
    var onPair: (String, String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var camera = CameraController()
    @State private var found = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            CameraPreview(session: camera.session).ignoresSafeArea()
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(.white.opacity(0.85), lineWidth: 3)
                .frame(width: 240, height: 240)
            VStack {
                HStack {
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark").font(.headline).foregroundStyle(.white)
                            .frame(width: 40, height: 40).background(.ultraThinMaterial, in: Circle())
                    }
                }
                .padding()
                Spacer()
                Text("Point at the code on your server's Settings page")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.bottom, 40)
            }
        }
        .preferredColorScheme(.dark)
        .task {
            guard await CameraController.requestAccess() else { return }
            let request = VNDetectBarcodesRequest()
            request.symbologies = [.qr]
            camera.onFrame = { buffer in
                let handler = VNImageRequestHandler(cvPixelBuffer: buffer, orientation: .up, options: [:])
                try? handler.perform([request])
                guard let payload = request.results?.first?.payloadStringValue, let parsed = PairingScanner.parse(payload) else { return }
                Task { @MainActor in
                    guard !found else { return }
                    found = true
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    camera.stop()
                    onPair(parsed.0, parsed.1)
                }
            }
            camera.start()
        }
        .onDisappear { camera.stop() }
    }

    static func parse(_ s: String) -> (String, String?)? {
        if s.hasPrefix("http://") || s.hasPrefix("https://") { return (s, nil) }
        guard let comps = URLComponents(string: s), comps.scheme == "comps", let url = comps.queryItems?.first(where: { $0.name == "url" })?.value else { return nil }
        return (url, comps.queryItems?.first(where: { $0.name == "token" })?.value)
    }
}
