#include <dlfcn.h>
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>

namespace {

constexpr std::uint32_t kBg3AppId = 1086940;
constexpr std::string_view kBg3AppIdText = "1086940";

using SteamApiInitFlat = int (*)(char*);
using SteamApiShutdown = void (*)();
using SteamApiSteamUtils = void* (*)();
using SteamApiUtilsGetAppId = std::uint32_t (*)(void*);
using SteamApiSteamRemoteStorage = void* (*)();
using SteamApiRemoteStorageIsCloudEnabledForApp = bool (*)(void*);
using SteamApiRemoteStorageSetCloudEnabledForApp = void (*)(void*, bool);

class ProtocolOutput {
 public:
  ProtocolOutput() {
    do {
      descriptor_ = fcntl(STDOUT_FILENO, F_DUPFD_CLOEXEC, 3);
    } while (descriptor_ < 0 && errno == EINTR);
    if (descriptor_ < 0) {
      throw std::system_error(errno, std::generic_category(),
                              "Could not preserve the protocol output");
    }

    int redirected;
    do {
      redirected = dup2(STDERR_FILENO, STDOUT_FILENO);
    } while (redirected < 0 && errno == EINTR);
    if (redirected < 0) {
      const int error = errno;
      close(descriptor_);
      throw std::system_error(error, std::generic_category(),
                              "Could not redirect Steamworks diagnostics");
    }
  }

  ProtocolOutput(const ProtocolOutput&) = delete;
  ProtocolOutput& operator=(const ProtocolOutput&) = delete;

  ~ProtocolOutput() {
    close(descriptor_);
    // Leave stdout on stderr for any buffered SDK output or atexit handlers.
  }

  void WriteLine(const std::string& message) const {
    const std::string line = message + '\n';
    std::string_view remaining(line);
    while (!remaining.empty()) {
      const ssize_t written = write(descriptor_, remaining.data(), remaining.size());
      if (written < 0 && errno == EINTR) continue;
      if (written <= 0) {
        throw std::system_error(written < 0 ? errno : EIO,
                                std::generic_category(),
                                "Could not write the protocol response");
      }
      remaining.remove_prefix(static_cast<std::size_t>(written));
    }
  }

 private:
  int descriptor_ = -1;
};

class SharedLibrary {
 public:
  explicit SharedLibrary(const std::string& path) {
    handle_ = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (handle_ == nullptr) {
      const char* error = dlerror();
      throw std::runtime_error(
          "Could not load the Steamworks library: " +
          std::string(error == nullptr ? "unknown dlopen error" : error));
    }
  }

  SharedLibrary(const SharedLibrary&) = delete;
  SharedLibrary& operator=(const SharedLibrary&) = delete;

  ~SharedLibrary() {
    if (handle_ != nullptr) dlclose(handle_);
  }

  template <typename Function>
  Function Resolve(const char* name) const {
    dlerror();
    void* symbol = dlsym(handle_, name);
    const char* error = dlerror();
    if (error != nullptr || symbol == nullptr) {
      throw std::runtime_error(
          "The Steamworks library does not export " + std::string(name));
    }
    return reinterpret_cast<Function>(symbol);
  }

  bool Exports(const char* name) const {
    dlerror();
    void* symbol = dlsym(handle_, name);
    return dlerror() == nullptr && symbol != nullptr;
  }

 private:
  void* handle_ = nullptr;
};

class SteamApiSession {
 public:
  SteamApiSession(SteamApiInitFlat init, SteamApiShutdown shutdown)
      : shutdown_(shutdown) {
    std::array<char, 1024> error_message{};
    const int result = init(error_message.data());
    if (result != 0) {
      throw std::runtime_error(
          "SteamAPI_InitFlat failed with result " + std::to_string(result) +
          ": " + error_message.data());
    }
    active_ = true;
  }

  SteamApiSession(const SteamApiSession&) = delete;
  SteamApiSession& operator=(const SteamApiSession&) = delete;

  ~SteamApiSession() {
    if (active_) shutdown_();
  }

 private:
  SteamApiShutdown shutdown_;
  bool active_ = false;
};

struct Arguments {
  enum class Operation { kBeginDisable, kRestore };

  std::string library_path;
  Operation operation = Operation::kBeginDisable;
  bool expected_original = false;
};

Arguments ParseArguments(int argc, char** argv) {
  if (argc < 4 || std::string_view(argv[1]) != "--steam-api") {
    throw std::runtime_error(
        "Usage: steam-cloud-helper --steam-api /absolute/libsteam_api.so "
        "begin-disable|restore [--expected-original true|false]");
  }

  const std::filesystem::path library_path(argv[2]);
  if (!library_path.is_absolute()) {
    throw std::runtime_error("The Steamworks library path must be absolute");
  }

  const std::string_view operation(argv[3]);
  if (operation == "begin-disable" && argc == 4) {
    return {.library_path = library_path.lexically_normal().string()};
  }
  if (operation == "restore" && argc == 6 &&
      std::string_view(argv[4]) == "--expected-original") {
    const std::string_view value(argv[5]);
    if (value != "true" && value != "false") {
      throw std::runtime_error(
          "The expected original state must be true or false");
    }
    return {
        .library_path = library_path.lexically_normal().string(),
        .operation = Arguments::Operation::kRestore,
        .expected_original = value == "true",
    };
  }
  throw std::runtime_error(
      "Usage: steam-cloud-helper --steam-api /absolute/libsteam_api.so "
      "begin-disable|restore [--expected-original true|false]");
}

void SetBg3Environment() {
  if (setenv("SteamAppId", kBg3AppIdText.data(), 1) != 0 ||
      setenv("SteamGameId", kBg3AppIdText.data(), 1) != 0) {
    throw std::runtime_error("Could not set the BG3 Steam AppID environment");
  }
}

const char* JsonBool(bool value) { return value ? "true" : "false"; }

std::string ReadHandshakeCommand() {
  pollfd input = {.fd = STDIN_FILENO, .events = POLLIN, .revents = 0};
  const int poll_result = poll(&input, 1, 30'000);
  if (poll_result == 0) {
    throw std::runtime_error("Timed out while waiting for the journal commit");
  }
  if (poll_result < 0) {
    throw std::runtime_error("Could not wait for the journal commit");
  }
  std::string command;
  if (!std::getline(std::cin, command)) {
    throw std::runtime_error("The journal controller disconnected");
  }
  return command;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    const Arguments arguments = ParseArguments(argc, argv);
    // Keep SDK stdout separate even during dlopen, shutdown and dlclose.
    const ProtocolOutput protocol;
    SetBg3Environment();

    const SharedLibrary library(arguments.library_path);
    const auto init = library.Resolve<SteamApiInitFlat>("SteamAPI_InitFlat");
    const auto shutdown =
        library.Resolve<SteamApiShutdown>("SteamAPI_Shutdown");
    // Only GetAppID is used, which ISteamUtils v010 and v011 both expose, so
    // an older Steamworks redistributable works too.
    const auto steam_utils = library.Resolve<SteamApiSteamUtils>(
        library.Exports("SteamAPI_SteamUtils_v011") ? "SteamAPI_SteamUtils_v011"
                                                     : "SteamAPI_SteamUtils_v010");
    const auto get_app_id = library.Resolve<SteamApiUtilsGetAppId>(
        "SteamAPI_ISteamUtils_GetAppID");
    const auto steam_remote_storage =
        library.Resolve<SteamApiSteamRemoteStorage>(
            "SteamAPI_SteamRemoteStorage_v016");
    const auto is_cloud_enabled =
        library.Resolve<SteamApiRemoteStorageIsCloudEnabledForApp>(
            "SteamAPI_ISteamRemoteStorage_IsCloudEnabledForApp");
    const auto set_cloud_enabled =
        library.Resolve<SteamApiRemoteStorageSetCloudEnabledForApp>(
            "SteamAPI_ISteamRemoteStorage_SetCloudEnabledForApp");

    const SteamApiSession session(init, shutdown);
    void* utils = steam_utils();
    void* remote_storage = steam_remote_storage();
    if (utils == nullptr || remote_storage == nullptr) {
      throw std::runtime_error("Steamworks did not provide the required interfaces");
    }
    const std::uint32_t actual_app_id = get_app_id(utils);
    if (actual_app_id != kBg3AppId) {
      throw std::runtime_error(
          "Steamworks initialized for AppID " + std::to_string(actual_app_id) +
          ", expected 1086940");
    }

    const bool original_enabled = is_cloud_enabled(remote_storage);
    if (arguments.operation == Arguments::Operation::kRestore) {
      if (original_enabled) {
        throw std::runtime_error(
            "Steam Cloud did not remain disabled before the restore");
      }
      if (original_enabled != arguments.expected_original) {
        set_cloud_enabled(remote_storage, arguments.expected_original);
      }
      const bool restored_enabled = is_cloud_enabled(remote_storage);
      if (restored_enabled != arguments.expected_original) {
        throw std::runtime_error(
            "Steamworks did not restore the expected Cloud state for BG3");
      }
      protocol.WriteLine(
          std::string("{\"schemaVersion\":1,\"appId\":1086940,"
                      "\"operation\":\"restore\",\"previousEnabled\":") +
          JsonBool(original_enabled) + ",\"enabled\":" +
          JsonBool(restored_enabled) + "}");
      return 0;
    }

    protocol.WriteLine(
        std::string("{\"schemaVersion\":1,\"appId\":1086940,"
                    "\"operation\":\"begin-disable\",\"phase\":\"ready\","
                    "\"originalEnabled\":") +
        JsonBool(original_enabled) + "}");
    const std::string command = ReadHandshakeCommand();
    if (command == "abort") {
      const bool unchanged_enabled = is_cloud_enabled(remote_storage);
      if (unchanged_enabled != original_enabled) {
        throw std::runtime_error(
            "Steam Cloud changed before the journal handshake was aborted");
      }
      protocol.WriteLine(
          std::string("{\"schemaVersion\":1,\"appId\":1086940,"
                      "\"operation\":\"begin-disable\",\"phase\":\"aborted\","
                      "\"originalEnabled\":") +
          JsonBool(original_enabled) + ",\"enabled\":" +
          JsonBool(unchanged_enabled) + "}");
      return 0;
    }
    if (command != "commit") {
      throw std::runtime_error("Expected commit or abort from the journal controller");
    }
    if (original_enabled) set_cloud_enabled(remote_storage, false);
    const bool disabled = is_cloud_enabled(remote_storage);
    if (disabled) {
      throw std::runtime_error(
          "Steamworks did not disable Cloud for BG3");
    }
    protocol.WriteLine(
        std::string("{\"schemaVersion\":1,\"appId\":1086940,"
                    "\"operation\":\"begin-disable\",\"phase\":\"complete\","
                    "\"originalEnabled\":") +
        JsonBool(original_enabled) + ",\"enabled\":false}");
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "steam-cloud-helper: " << error.what() << '\n';
    return 1;
  }
}
