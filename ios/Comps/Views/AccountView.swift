import SwiftUI
import SwiftData

/// Sign in or create an account (the same one as on the website).
@MainActor
struct SignInSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @State private var creating = false
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var field: Field?

    private enum Field { case email, password }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("", selection: $creating) {
                        Text("Sign in").tag(false)
                        Text("Create account").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                Section {
                    TextField("Email", text: $email)
                        .keyboardType(.emailAddress)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($field, equals: .email)
                        .submitLabel(.next)
                        .onSubmit { field = .password }
                    SecureField(creating ? "Password (6+ characters)" : "Password", text: $password)
                        .textContentType(creating ? .newPassword : .password)
                        .focused($field, equals: .password)
                        .submitLabel(.go)
                        .onSubmit { Task { await submit() } }
                } footer: {
                    if let error {
                        Text(error).foregroundStyle(Color.down)
                    } else {
                        Text(creating
                             ? "Your collection, watchlist and drop alerts follow you to the website and any phone. Cards already on this phone are added to your new account."
                             : "Use the same email and password as on the website.")
                    }
                }
                Section {
                    Button {
                        Task { await submit() }
                    } label: {
                        HStack {
                            Spacer()
                            if busy { ProgressView() } else { Text(creating ? "Create account" : "Sign in").bold() }
                            Spacer()
                        }
                    }
                    .disabled(busy || !email.contains("@") || password.count < 6)
                }
            }
            .navigationTitle(creating ? "Create account" : "Sign in")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .onAppear { field = .email }
            .animation(.snappy, value: creating)
        }
    }

    private func submit() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        error = nil
        do {
            if creating { try await Account.shared.signUp(email: email, password: password) }
            else { try await Account.shared.signIn(email: email, password: password) }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            dismiss()
            await Portfolio.refreshPrices(context: context)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// The Account section of Settings.
@MainActor
struct AccountSection: View {
    @Environment(\.modelContext) private var context
    @State private var signingIn = false
    @State private var changing = false
    @State private var newPassword = ""
    @State private var message: String?
    @State private var confirmSignOut = false
    private var account: Account { .shared }
    private var sync: CollectionSync { .shared }

    var body: some View {
        Section {
            if !account.isEnabled {
                Text("Accounts aren't switched on for this site yet. Your collection is saved on this phone.")
                    .font(.footnote).foregroundStyle(.secondary)
            } else if let email = account.email, account.isSignedIn {
                HStack(spacing: 12) {
                    Text(String(email.prefix(1)).uppercased())
                        .font(.headline).foregroundStyle(.tint)
                        .frame(width: 36, height: 36)
                        .background(Color.accentColor.opacity(0.14), in: Circle())
                    VStack(alignment: .leading, spacing: 2) {
                        Text(email).font(.subheadline.weight(.semibold)).lineLimit(1)
                        Text(status).font(.footnote).foregroundStyle(sync.lastError == nil ? Color.secondary : Color.down)
                    }
                }
                Button {
                    Task { await sync.sync(context) }
                } label: {
                    HStack { Text("Sync now"); if sync.syncing { Spacer(); ProgressView() } }
                }
                .disabled(sync.syncing)
                if changing {
                    SecureField("New password (6+)", text: $newPassword).textContentType(.newPassword)
                    Button("Save new password") {
                        Task {
                            do {
                                try await account.changePassword(newPassword)
                                message = "Password changed."
                                changing = false
                                newPassword = ""
                            } catch { message = error.localizedDescription }
                        }
                    }
                    .disabled(newPassword.count < 6)
                } else {
                    Button("Change password") { changing = true }
                }
                if let message { Text(message).font(.footnote).foregroundStyle(.secondary) }
                Button("Sign out", role: .destructive) { confirmSignOut = true }
            } else {
                Button { signingIn = true } label: { Label("Sign in or create account", systemImage: "person.crop.circle.badge.plus") }
            }
        } header: {
            Text("Account")
        } footer: {
            if account.isEnabled {
                Text(account.isSignedIn
                     ? "Your collection, watchlist and drop alerts stay in step with the website and any phone signed in to this account."
                     : "Sign in to keep your collection in your account and see it on the website.")
            }
        }
        .sheet(isPresented: $signingIn) { SignInSheet() }
        .confirmationDialog("Sign out?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await sync.signOut(context) } }
        } message: {
            Text("Your cards stay in your account. This phone forgets them until you sign in again.")
        }
    }

    private var status: String {
        if let e = sync.lastError { return e }
        if sync.syncing { return "Syncing…" }
        guard let last = sync.lastSync else { return "Signed in" }
        let cards = sync.count.map { " · \($0) card\($0 == 1 ? "" : "s")" } ?? ""
        return "Synced \(last.formatted(.relative(presentation: .named)))\(cards)"
    }
}
