cask "serial-terminal" do
  version "0.1.0"

  if Hardware::CPU.arm?
    url "https://github.com/hulryung/serial-rs/releases/download/v#{version}/Serial-Terminal_#{version}_aarch64.dmg"
    sha256 "PLACEHOLDER"
  else
    url "https://github.com/hulryung/serial-rs/releases/download/v#{version}/Serial-Terminal_#{version}_x64.dmg"
    sha256 "PLACEHOLDER"
  end

  name "Serial Terminal"
  desc "A modern serial terminal app"
  homepage "https://github.com/hulryung/serial-rs"

  app "Serial Terminal.app"

  caveats <<~EOS
    This app is not signed with an Apple Developer ID certificate.
    On first launch, you may need to allow it in:
      System Settings > Privacy & Security
    Or run: xattr -cr "/Applications/Serial Terminal.app"
  EOS

  zap trash: [
    "~/Library/Application Support/com.serialrs.terminal",
    "~/Library/Caches/com.serialrs.terminal",
    "~/Library/Preferences/com.serialrs.terminal.plist",
  ]
end
