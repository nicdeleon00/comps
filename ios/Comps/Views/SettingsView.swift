import SwiftUI
import SwiftData
import Vision

@MainActor
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @AppStorage(Pref.dataURL) private var dataURL = ""
    @AppStorage(Pref.haptics) private var haptics = true
    @AppStorage(Pref.scanSound) private var sound = false
    @AppStorage(Pref.scanCondition) private var scanCondition = "NM"
    @AppStorage(Pref.autoAccept) private var autoAccept = 0.8

    @State private var status: HostedStatus?
    @State private var catalogCount = 0
    @State private var catalogDate: Date?
    @State private var updating = false
    @State private var error: String?
    @State private var showPairing = false
    @State private var syncKey = ""
    @State private var connecting = false
    @State private var syncMessage: String?

    private var sync: CollectionSync { .shared }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Cards", value: catalogCount > 0 ? catalogCount.formatted() : "Not downloaded")
                    LabeledContent("Prices from", value: catalogDate.map { $0.formatted(.relative(presentation: .named)) } ?? "—")
                    if let status {
                        LabeledContent("Open deals", value: status.counts.deals.formatted())
                        LabeledContent("Graded prices", value: status.providers["pricecharting"]?.on == true ? "On" : "Needs PriceCharting")
                        LabeledContent("eBay listings", value: status.providers["ebay"]?.on == true ? "On" : "Needs eBay keys")
                    }
                    Button {
                        Task { await update() }
                    } label: {
                        HStack { Text("Update prices now"); if updating { Spacer(); ProgressView() } }
                    }
                    .disabled(updating)
                    if let error { Text(error).font(.footnote).foregroundStyle(Color.down) }
                } header: {
                    Text("Prices")
                } footer: {
                    Text("Prices refresh on GitHub every 6 hours. The app keeps a copy of every English Pokémon card, so scanning and values work offline.")
                }

                Section {
                    if sync.isConnected {
                        LabeledContent("Status", value: sync.syncing ? "Syncing…" : sync.lastError == nil ? "On" : "Needs attention")
                        LabeledContent("Last synced", value: sync.lastSync.map { $0.formatted(.relative(presentation: .named)) } ?? "—")
                        if let n = sync.count { LabeledContent("Cards", value: n.formatted()) }
                        if let e = sync.lastError { Text(e).font(.footnote).foregroundStyle(Color.down) }
                        Button {
                            Task { await sync.sync(context) }
                        } label: {
                            HStack { Text("Sync now"); if sync.syncing { Spacer(); ProgressView() } }
                        }
                        .disabled(sync.syncing)
                        Button {
                            UIPasteboard.general.string = sync.token
                            syncMessage = "Key copied — paste it into Comps on your Home Screen for drop alerts."
                        } label: { Label("Copy sync key", systemImage: "doc.on.doc") }
                        if let syncMessage { Text(syncMessage).font(.footnote).foregroundStyle(.secondary) }
                        Button("Stop syncing", role: .destructive) { sync.disconnect() }
                    } else {
                        Button { showPairing = true } label: { Label("Scan code from website", systemImage: "qrcode.viewfinder") }
                        HStack {
                            SecureField("Or paste GitHub key", text: $syncKey)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                            if connecting {
                                ProgressView()
                            } else {
                                Button("Connect") { Task { await connectSync(token: syncKey, gist: nil) } }
                                    .disabled(syncKey.trimmingCharacters(in: .whitespaces).isEmpty)
                            }
                        }
                        if let syncMessage { Text(syncMessage).font(.footnote).foregroundStyle(Color.down) }
                    }
                } header: {
                    Text("Sync with computer")
                } footer: {
                    Text(sync.isConnected
                         ? "Cards you scan show up on the website, and changes there come back here. Stored in a secret gist on your GitHub account."
                         : "On your computer, open the website's Settings, follow “Sync with iPhone”, then scan the code it shows.")
                }

                Section {
                    TextField(HostedData.defaultURL, text: $dataURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await update() } }
                    Button { showPairing = true } label: { Label("Scan site code", systemImage: "qrcode.viewfinder") }
                } header: {
                    Text("Price site")
                } footer: {
                    Text("Leave blank to use \(HostedData.defaultURL). The website's Settings page has a code you can scan.")
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
                    LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0")
                    Text("Prices: TCGplayer via TCGCSV, Cardmarket via TCGdex. Card images © their owners.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await refreshInfo() }
            .sheet(isPresented: $showPairing) {
                PairingScanner { code in
                    showPairing = false
                    switch code {
                    case .site(let url):
                        dataURL = url
                        Task { await update() }
                    case .sync(let token, let gist):
                        Task { await connectSync(token: token, gist: gist) }
                    }
                }
            }
        }
    }

    private func connectSync(token: String, gist: String?) async {
        connecting = true
        defer { connecting = false }
        syncMessage = nil
        do {
            try await CollectionSync.shared.connect(token: token, gist: gist, context: context)
            await Portfolio.reprice(context: context)
            syncKey = ""
        } catch {
            syncMessage = error.localizedDescription
        }
    }

    private func refreshInfo() async {
        catalogCount = await Catalog.shared.count
        catalogDate = await Catalog.shared.updatedAt
        status = try? await HostedData.current.status()
    }

    private func update() async {
        updating = true
        defer { updating = false }
        error = nil
        do {
            status = try await HostedData.current.status()
        } catch {
            self.error = "Couldn't reach the price site: \(error.localizedDescription)"
        }
        await Catalog.shared.ensureLoaded(force: true)
        await Portfolio.refreshPrices(context: context)
        await refreshInfo()
    }
}

/// What a website QR code asks for.
enum PairingCode {
    /// comps://connect?url=… — use this price site.
    case site(String)
    /// comps://sync?token=…&gist=… — sync the collection with the website.
    case sync(token: String, gist: String?)
}

/// Reads the QR codes on the website's Settings page.
@MainActor
struct PairingScanner: View {
    var onCode: (PairingCode) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var camera = CameraController(preset: .hd1920x1080)
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
                Text("Point at the code on the website's Settings page")
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
                guard let payload = request.results?.first?.payloadStringValue, let code = PairingScanner.code(payload) else { return }
                Task { @MainActor in
                    guard !found else { return }
                    found = true
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    camera.stop()
                    onCode(code)
                }
            }
            camera.start()
        }
        .onDisappear { camera.stop() }
    }

    nonisolated static func code(_ s: String) -> PairingCode? {
        if let sync = CollectionSync.parse(s) { return .sync(token: sync.token, gist: sync.gist) }
        if let site = parse(s) { return .site(site.0) }
        return nil
    }

    nonisolated static func parse(_ s: String) -> (String, String?)? {
        if s.hasPrefix("http://") || s.hasPrefix("https://") { return (s, nil) }
        guard let comps = URLComponents(string: s), comps.scheme == "comps", let url = comps.queryItems?.first(where: { $0.name == "url" })?.value else { return nil }
        return (url, comps.queryItems?.first(where: { $0.name == "token" })?.value)
    }
}
