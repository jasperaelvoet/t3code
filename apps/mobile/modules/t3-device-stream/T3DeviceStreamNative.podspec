require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'T3DeviceStreamNative'
  s.version = package['version']
  s.summary = 'Native low latency device stream for T3 Code mobile.'
  s.description = 'Receives, decodes and shows the direct device stream, and sends touches back.'
  s.homepage = 'https://t3tools.com'
  s.license = { :type => 'UNLICENSED' }
  s.author = { 'T3 Tools' => 'hello@t3tools.com' }
  s.platforms = { :ios => '16.4' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.swift'
  s.frameworks = 'AVFoundation', 'CoreMedia', 'CoreVideo', 'UIKit', 'VideoToolbox'
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
