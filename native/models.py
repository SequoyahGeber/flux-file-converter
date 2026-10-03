import bpy, sys, pathlib
args = sys.argv[sys.argv.index('--') + 1:]
source, target, output = args
ext = pathlib.Path(source).suffix.lower()
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
if ext == '.blend': bpy.ops.wm.open_mainfile(filepath=source, load_ui=False, use_scripts=False)
elif ext == '.obj': bpy.ops.wm.obj_import(filepath=source)
elif ext == '.stl': bpy.ops.wm.stl_import(filepath=source)
elif ext == '.ply': bpy.ops.wm.ply_import(filepath=source)
elif ext == '.fbx': bpy.ops.import_scene.fbx(filepath=source)
elif ext in ('.gltf', '.glb'): bpy.ops.import_scene.gltf(filepath=source)
elif ext in ('.usd', '.usda', '.usdc', '.usdz'): bpy.ops.wm.usd_import(filepath=source)
elif ext == '.abc': bpy.ops.wm.alembic_import(filepath=source)
else: raise ValueError('Unsupported 3D input format')
if not any(obj.type == 'MESH' for obj in bpy.context.scene.objects): raise ValueError('No mesh objects were found in this 3D file.')
if target == 'blend':
    bpy.ops.file.pack_all(); bpy.ops.wm.save_as_mainfile(filepath=output)
elif target == 'obj': bpy.ops.wm.obj_export(filepath=output)
elif target == 'stl': bpy.ops.wm.stl_export(filepath=output)
elif target == 'ply': bpy.ops.wm.ply_export(filepath=output)
elif target == 'fbx': bpy.ops.export_scene.fbx(filepath=output, path_mode='COPY', embed_textures=True)
elif target in ('glb', 'gltf'): bpy.ops.export_scene.gltf(filepath=output, export_format='GLB' if target == 'glb' else 'GLTF_SEPARATE')
elif target in ('usd', 'usda', 'usdc', 'usdz'): bpy.ops.wm.usd_export(filepath=output)
else: raise ValueError('Unsupported 3D output format')
