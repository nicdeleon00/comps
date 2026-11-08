import UIKit
import ImageIO

/// Crash protection for the scanner. The tray (every scanned card not yet added) is saved
/// to disk as it changes, with a photo of each scan, so a crash, closing the scanner or
/// closing the app never loses a session. The next time the scanner opens, it picks up
/// where it left off. Separate from the collection's own storage, which it never touches.
enum ScanJournal {
    struct Entry: Codable {
        var id: UUID
        var scannedAt: Date
        var status: String
        var candidates: [ScanCandidate]
        var selected: Int
        var variant: String?
        var grader: String?
        var grade: String?
        var condition: String
        var quantity: Int
        var pocket: String?
        var memoryKey: String?
    }

    private struct Saved: Codable {
        var version = 1
        var items: [Entry]
    }

    /// Every read and write runs here, in order, so a photo is always on disk before a save that keeps it.
    private static let queue = DispatchQueue(label: "comps.scan-journal", qos: .userInitiated)

    private static let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("ScanTray", isDirectory: true)
    private static let trayFile = folder.appendingPathComponent("tray.json")
    private static let photos = folder.appendingPathComponent("photos", isDirectory: true)
    private static func photoURL(_ id: UUID) -> URL { photos.appendingPathComponent("\(id.uuidString).jpg") }

    /// Saves the tray as it is now (newest first). An empty tray clears the folder.
    static func save(_ items: [ScanItem]) {
        let entries = items.map { Entry($0) }
        queue.async { write(entries) }
    }

    static func savePhoto(_ jpeg: Data?, for id: UUID) {
        guard let jpeg else { return }
        queue.async {
            try? FileManager.default.createDirectory(at: photos, withIntermediateDirectories: true)
            try? jpeg.write(to: photoURL(id), options: .atomic)
        }
    }

    /// The review screen's copy of a scan.
    static func photo(_ id: UUID) async -> UIImage? {
        await withCheckedContinuation { done in
            queue.async { done.resume(returning: UIImage(contentsOfFile: photoURL(id).path)?.preparingForDisplay()) }
        }
    }

    /// The tray as last saved, each card with a small picture for the tray.
    static func load() async -> [(Entry, UIImage?)] {
        await withCheckedContinuation { done in
            queue.async {
                guard let data = try? Data(contentsOf: trayFile) else { done.resume(returning: []); return }
                guard let saved = try? JSONDecoder().decode(Saved.self, from: data) else {
                    // Unreadable (shouldn't happen): keep it aside rather than overwrite it.
                    let aside = folder.appendingPathComponent("tray-unreadable-\(Int(Date().timeIntervalSince1970)).json")
                    try? FileManager.default.moveItem(at: trayFile, to: aside)
                    done.resume(returning: [])
                    return
                }
                done.resume(returning: saved.items.map { ($0, thumbnail(photoURL($0.id))) })
            }
        }
    }

    private static func write(_ entries: [Entry]) {
        let fm = FileManager.default
        guard !entries.isEmpty else {
            try? fm.removeItem(at: trayFile)
            try? fm.removeItem(at: photos)
            return
        }
        try? fm.createDirectory(at: photos, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(Saved(items: entries)) else { return }
        try? data.write(to: trayFile, options: .atomic)
        // Photos of cards that have since been added or removed.
        let keep = Set(entries.map { "\($0.id.uuidString).jpg" })
        for name in (try? fm.contentsOfDirectory(atPath: photos.path)) ?? [] where !keep.contains(name) {
            try? fm.removeItem(at: photos.appendingPathComponent(name))
        }
    }

    private static func thumbnail(_ url: URL) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: 200,
            kCGImageSourceCreateThumbnailWithTransform: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map(UIImage.init(cgImage:))
    }
}

extension ScanJournal.Entry {
    init(_ item: ScanItem) {
        // The likely matches, and always the chosen one.
        var list = Array(item.candidates.prefix(12))
        var chosen = item.selected
        if let c = item.choice, !(list.indices.contains(chosen) && list[chosen].id == c.id) {
            list.append(c)
            chosen = list.count - 1
        }
        self.init(id: item.id, scannedAt: item.scannedAt, status: item.status.rawValue, candidates: list, selected: chosen,
                  variant: item.variant, grader: item.grader, grade: item.grade, condition: item.condition,
                  quantity: item.quantity, pocket: item.pocket, memoryKey: item.memoryKey)
    }
}
