using LSLib.LS;
using LSLib.LS.Enums;

if (args.Length != 2)
{
    Console.Error.WriteLine("Usage: LSLibPacker <source-directory> <destination-pak>");
    return 2;
}

var source = Path.GetFullPath(args[0]);
var destination = Path.GetFullPath(args[1]);
if (!Directory.Exists(source))
{
    Console.Error.WriteLine($"Source directory does not exist: {source}");
    return 2;
}

var build = new PackageBuildData
{
    Version = PackageVersion.V18,
    Compression = CompressionMethod.LZ4,
    CompressionLevel = LSCompressionLevel.Default,
    Hash = true,
    Priority = 0
};

var packager = new Packager();
await packager.CreatePackage(destination, source, build);
Console.WriteLine($"Packed {destination}");

var expectedFiles = Directory
    .EnumerateFiles(source, "*.*", SearchOption.AllDirectories)
    .Select(file => Path.GetRelativePath(source, file))
    .Order(StringComparer.Ordinal)
    .ToArray();
var reader = new PackageReader();
using var package = reader.Read(destination);
var packagedFiles = package.Files
    .Where(file => !file.IsDeletion())
    .OrderBy(file => file.Name, StringComparer.Ordinal)
    .ToArray();
if (package.Version != PackageVersion.V18)
{
    Console.Error.WriteLine($"Generated package has unexpected version {package.Version}");
    return 1;
}
if (!expectedFiles.SequenceEqual(packagedFiles.Select(file => file.Name), StringComparer.Ordinal))
{
    Console.Error.WriteLine("Generated package file list does not match the source directory");
    return 1;
}

var sourceBuffer = new byte[81920];
var packageBuffer = new byte[81920];
foreach (var file in packagedFiles)
{
    using var sourceContents = File.OpenRead(Path.Combine(source, file.Name));
    using var contents = file.CreateContentReader();
    if (sourceContents.Length != (long)file.Size())
    {
        Console.Error.WriteLine($"Generated package entry has an invalid size: {file.Name}");
        return 1;
    }

    while (true)
    {
        var sourceCount = sourceContents.Read(sourceBuffer, 0, sourceBuffer.Length);
        var packageCount = contents.Read(packageBuffer, 0, packageBuffer.Length);
        if (sourceCount != packageCount
            || !sourceBuffer.AsSpan(0, sourceCount).SequenceEqual(packageBuffer.AsSpan(0, packageCount)))
        {
            Console.Error.WriteLine($"Generated package entry differs from its source: {file.Name}");
            return 1;
        }
        if (sourceCount == 0)
        {
            break;
        }
    }
}
Console.WriteLine($"Verified {packagedFiles.Length} files in {destination}");
return 0;
