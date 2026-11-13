# jelly-host: the Strudel Jelly audio engine (AGPL-3.0-or-later, like the app).
# Build: npm run host:build (runs host/build.mjs). Output: host/bin/jelly-host(.exe)
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
  src/Engine.cpp
  src/StreamInput.cpp
  src/Pipe.cpp
  ${PLATFORM_SOURCES})

target_compile_definitions(jelly-host PRIVATE
  JUCE_PLUGINHOST_VST3=1
  JUCE_PLUGINHOST_AU=0
  JUCE_PLUGINHOST_LADSPA=0
  JUCE_PLUGINHOST_LV2=0
  JUCE_ASIO=0
  JUCE_WASAPI=1
  JUCE_DIRECTSOUND=1
  JUCE_WEB_BROWSER=0
  JUCE_USE_CURL=0
  JUCE_USE_CAMERA=0
  JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:jelly-host,JUCE_PRODUCT_NAME>"
  JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:jelly-host,JUCE_VERSION>")

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
