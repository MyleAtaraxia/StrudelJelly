# jelly-host: the Strudel Jelly audio engine (AGPL-3.0-or-later, like the app).
# Build: npm run host:build (runs host/build.mjs). Output: host/bin/jelly-host(.exe), and on Windows
# host/bin/jelly-bridge32.exe, the 32-bit plugin bridge (a second, 32-bit configure with JELLY_BRIDGE32=ON).
cmake_minimum_required(VERSION 3.22)
project(jelly_host VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>") # static CRT: one self-contained exe

include(FetchContent)
FetchContent_Declare(JUCE
  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
  GIT_TAG 8.0.15
  GIT_SHALLOW TRUE
  GIT_PROGRESS TRUE)
FetchContent_MakeAvailable(JUCE)

# ASIO SDK 2.3.4 (Steinberg, dual licensed: proprietary or GPLv3; we use it under GPLv3, which AGPL-3.0 code may be
# combined with). Only its headers are used; JUCE implements the host side. Set JELLY_ASIO=OFF to build without it.
option(JELLY_ASIO "Build the ASIO driver (Windows)" ON)
if(WIN32 AND JELLY_ASIO)
  FetchContent_Declare(asiosdk
    URL https://download.steinberg.net/sdk_downloads/ASIO-SDK_2.3.4_2025-10-15.zip
    URL_HASH SHA256=d5ebf0c20dd2c5f43771fd0c1418f4b361bf52434ee670097cfa6b3a335e2eca
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
  FetchContent_MakeAvailable(asiosdk)
  set(JELLY_HAS_ASIO 1)
else()
  set(JELLY_HAS_ASIO 0)
endif()

# VST2 hosting. JUCE needs the VST2 headers, which Steinberg no longer licenses (and their SDK cannot be combined
# with AGPL code). FST is a reverse-engineered replacement, GPL-3.0-or-later; vst2/ maps JUCE's include paths onto it.
# Set JELLY_VST2=OFF to build VST3 only.
option(JELLY_VST2 "Host VST2 plugins (through FST)" ON)
if(JELLY_VST2)
  FetchContent_Declare(fst
    GIT_REPOSITORY https://git.iem.at/zmoelnig/FST.git
    GIT_TAG 647af068765b75867e3a28b4dd8991ab9ed47f7c
    PATCH_COMMAND ${CMAKE_COMMAND} -P ${CMAKE_CURRENT_SOURCE_DIR}/vst2/patch-fst.cmake
    SOURCE_SUBDIR headers-only) # no such folder: fetch the headers, build nothing of FST's own
  FetchContent_MakeAvailable(fst)
  set(JELLY_HAS_VST2 1)
else()
  set(JELLY_HAS_VST2 0)
endif()

# JELLY_BRIDGE32=ON (a 32-bit Windows build): only jelly-bridge32, which runs one 32-bit VST2 plugin for jelly-host
option(JELLY_BRIDGE32 "Build only the 32-bit plugin bridge" OFF)
if(JELLY_BRIDGE32)
  if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 4 OR NOT JELLY_HAS_VST2)
    message(FATAL_ERROR "JELLY_BRIDGE32 needs a 32-bit Windows build with JELLY_VST2")
  endif()
  juce_add_gui_app(jelly-bridge32 PRODUCT_NAME "jelly-bridge32" COMPANY_NAME "Strudel Jelly" VERSION ${PROJECT_VERSION})
  target_sources(jelly-bridge32 PRIVATE src/BridgeServer.cpp src/platform_win.cpp)
  target_compile_definitions(jelly-bridge32 PRIVATE
    JUCE_PLUGINHOST_VST3=0 JUCE_PLUGINHOST_VST=1 JUCE_PLUGINHOST_AU=0 JUCE_PLUGINHOST_LADSPA=0 JUCE_PLUGINHOST_LV2=0
    JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0 FST_DONT_DEPRECATE_UNKNOWN=1)
  target_include_directories(jelly-bridge32 PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/vst2 ${fst_SOURCE_DIR})
  target_link_libraries(jelly-bridge32 PRIVATE
    juce::juce_audio_processors
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags)
  # No manifest: JUCE asks for common controls 6, and under it the module loader inside SynthEdit 2009 plugins
  # fails ("Can't load Module"), leaving them silent. Old plugins expect the default controls anyway.
  # comctl32 is delay-loaded because JUCE's one import from it (TaskDialogIndirect, for its own message boxes,
  # which the bridge never shows) exists only in common controls 6 and would stop the exe from starting.
  target_link_options(jelly-bridge32 PRIVATE /MANIFEST:NO /DELAYLOAD:comctl32.dll)
  target_link_libraries(jelly-bridge32 PRIVATE delayimp.lib)
  add_custom_command(TARGET jelly-bridge32 POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory ${CMAKE_CURRENT_SOURCE_DIR}/bin
    COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_FILE:jelly-bridge32> ${CMAKE_CURRENT_SOURCE_DIR}/bin/)
  return()
endif()

juce_add_gui_app(jelly-host
  PRODUCT_NAME "jelly-host"
  COMPANY_NAME "Strudel Jelly"
  VERSION ${PROJECT_VERSION})

set(PLATFORM_SOURCES)
if(WIN32)
  list(APPEND PLATFORM_SOURCES src/platform_win.cpp)
else()
  list(APPEND PLATFORM_SOURCES src/platform_posix.cpp)
endif()

target_sources(jelly-host PRIVATE
  src/Main.cpp
  src/BridgeClient.cpp
  src/Engine.cpp
  src/Params.cpp
  src/Plugin.cpp
  src/Rack.cpp
  src/StreamInput.cpp
  src/Pipe.cpp
  ${PLATFORM_SOURCES})

target_compile_definitions(jelly-host PRIVATE
  JUCE_PLUGINHOST_VST3=1
  JUCE_PLUGINHOST_VST=${JELLY_HAS_VST2}
  JUCE_PLUGINHOST_AU=0
  JUCE_PLUGINHOST_LADSPA=0
  JUCE_PLUGINHOST_LV2=0
  JUCE_ASIO=${JELLY_HAS_ASIO}
  JUCE_WASAPI=1
  JUCE_DIRECTSOUND=1
  JUCE_WEB_BROWSER=0
  JUCE_USE_CURL=0
  JUCE_USE_CAMERA=0
  JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:jelly-host,JUCE_PRODUCT_NAME>"
  JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:jelly-host,JUCE_VERSION>")

if(JELLY_HAS_VST2)
  target_include_directories(jelly-host PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/vst2 ${fst_SOURCE_DIR})
  target_compile_definitions(jelly-host PRIVATE FST_DONT_DEPRECATE_UNKNOWN=1)
endif()

if(JELLY_HAS_ASIO)
  target_include_directories(jelly-host PRIVATE ${asiosdk_SOURCE_DIR}/common)
endif()

target_link_libraries(jelly-host PRIVATE
  juce::juce_audio_utils
  juce::juce_audio_processors
  juce::juce_audio_devices
  juce::juce_recommended_config_flags
  juce::juce_recommended_warning_flags)

# copy the exe to host/bin so Electron (dev) and electron-builder (extraResources) find it at a fixed path
add_custom_command(TARGET jelly-host POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E make_directory ${CMAKE_CURRENT_SOURCE_DIR}/bin
  COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_FILE:jelly-host> ${CMAKE_CURRENT_SOURCE_DIR}/bin/)
