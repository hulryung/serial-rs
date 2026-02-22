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

  zap trash: [
    "~/Library/Application Support/com.serialrs.terminal",
    "~/Library/Caches/com.serialrs.terminal",
    "~/Library/Preferences/com.serialrs.terminal.plist",
  ]
end
