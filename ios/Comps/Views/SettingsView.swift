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
                PairingScanner { url, _ in
                    dataURL = url
                    showPairing = false
                    Task { await update() }
                }
            }
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

/// Reads the QR code on the website's Settings page: comps://connect?url=…
@MainActor
struct PairingScanner: View {
    var onPair: (String, String?) -> Void
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

    nonisolated static func parse(_ s: String) -> (String, String?)? {
        if s.hasPrefix("http://") || s.hasPrefix("https://") { return (s, nil) }
        guard let comps = URLComponents(string: s), comps.scheme == "comps", let url = comps.queryItems?.first(where: { $0.name == "url" })?.value else { return nil }
        return (url, comps.queryItems?.first(where: { $0.name == "token" })?.value)
    }
}
